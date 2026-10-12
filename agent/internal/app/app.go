// Package app conecta todas las piezas del agente.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/mem"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/conn"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/logs"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

const (
	observeEvery   = 10 * time.Second
	reconcileEvery = 30 * time.Second
	retryEvery     = 2 * time.Second
	droppedEvery   = 5 * time.Second
)

// logStream es un stream de logs abierto por el panel.
type logStream struct{ cancel context.CancelFunc }

// App es el agente completo: reconciliador, hub de logs y mensajes del panel.
type App struct {
	cfg    Config
	st     *store.Store
	eng    docker.Engine
	rec    *reconcile.Reconciler
	hub    *logs.Hub
	log    *slog.Logger
	status mc.StatusFunc
	rcon   func(ctx context.Context, host string, port uint16, password, command string) (string, error)

	mu      sync.Mutex
	send    func(*mcsmv1.Envelope) error
	streams map[uint64]*logStream
}

// New construye la aplicación. send se fija después (Run) o en tests.
func New(cfg Config, st *store.Store, eng docker.Engine, log *slog.Logger) *App {
	a := &App{cfg: cfg, st: st, eng: eng, log: log, status: mc.Status, rcon: mc.Rcon, streams: map[uint64]*logStream{}}
	a.send = func(*mcsmv1.Envelope) error { return conn.ErrNotConnected }
	a.rec = reconcile.New(st, eng, cfg.DataRoot, cfg.Network, func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
		return a.status(ctx, host, port)
	}, a.onObserved)
	a.hub = logs.NewHub(eng)
	return a
}

// Run es el punto de entrada del binario.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	if err := os.MkdirAll(cfg.AgentData, 0o700); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(cfg.AgentData, "agent.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	eng, err := docker.NewMoby()
	if err != nil {
		return err
	}
	if _, err := eng.Version(ctx); err != nil {
		return fmt.Errorf("no se puede hablar con Docker (¿está montado /var/run/docker.sock?): %w", err)
	}
	if err := eng.EnsureNetwork(ctx, cfg.Network); err != nil {
		return fmt.Errorf("crear red %s: %w", cfg.Network, err)
	}

	// Spec §6.1: solo se da de alta si no hay token guardado.
	creds, err := st.Credentials()
	if err != nil {
		return err
	}
	if creds == nil {
		if cfg.EnrollToken == "" {
			return errors.New("este agente no está dado de alta: define ENROLL_TOKEN (se genera en Nodos → Añadir nodo)")
		}
		log.Info("dando de alta el nodo en el panel", "panel", cfg.PanelURL)
		res, err := conn.Enroll(ctx, cfg.PanelURL, cfg.EnrollToken, cfg.NameHint, cfg.Version)
		if err != nil {
			return err
		}
		creds = &store.Credentials{NodeID: res.NodeID, Token: res.NodeToken}
		if err := st.SaveCredentials(*creds); err != nil {
			return err
		}
		log.Info("nodo dado de alta", "node_id", res.NodeID)
	}

	a := New(cfg, st, eng, log)
	client := conn.NewClient(conn.Options{
		PanelURL: cfg.PanelURL, Token: creds.Token, Hello: a.hello, Handler: a, Log: log,
		OnDisconnect: a.cancelAllStreams,
		OnAuthRejected: func() {
			log.Error("el panel rechazó las credenciales del nodo; revisa que el nodo no haya sido eliminado")
		},
	})
	a.send = func(e *mcsmv1.Envelope) error { return client.Send(ctx, e) }

	go a.eventLoop(ctx)
	go a.tickers(ctx)
	a.rec.ReconcileAll(ctx)
	client.Run(ctx)
	return nil
}

func (a *App) hello(ctx context.Context) *mcsmv1.Hello {
	vers, _ := a.st.SpecVersions()
	dv, _ := a.eng.Version(ctx)
	host, _ := os.Hostname()
	info := &mcsmv1.HostInfo{Hostname: host, Cpus: uint32(runtime.NumCPU()), Os: runtime.GOOS, Arch: runtime.GOARCH}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemTotalBytes = vm.Total
	}
	return &mcsmv1.Hello{AgentVersion: a.cfg.Version, DockerVersion: dv, Host: info, SpecVersions: vers}
}

// onObserved se invoca con el lock por servidor tomado: no puede llamar al reconciliador.
func (a *App) onObserved(serverID string, obs *mcsmv1.Observed) {
	_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_ServerObserved{ServerObserved: &mcsmv1.ServerObserved{
		ServerId: serverID, Observed: obs, TsUnixMs: time.Now().UnixMilli(),
	}}})
}

func ack(id uint64) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}
}

func errMsg(id uint64, code string, err error) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: code, Message: err.Error()}}}
}

// applySpec valida y aplica una spec del panel (guarda de versión incluida en el reconciliador).
func (a *App) applySpec(ctx context.Context, sp *mcsmv1.ServerSpec) (code string, err error) {
	if sp == nil || sp.ServerId == "" || !spec.ValidSlug(sp.Slug) {
		return "invalid_spec", errors.New("spec inválida: server_id o slug no válido")
	}
	if err := a.rec.Apply(ctx, sp); err != nil {
		return "apply_failed", err
	}
	return "", nil
}

// Handle implementa conn.Handler.
func (a *App) Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_HelloAck:
		a.log.Info("panel confirmó la sesión", "node_id", b.HelloAck.NodeId)

	case *mcsmv1.Envelope_SyncSpecs:
		for _, sp := range b.SyncSpecs.Servers {
			if _, err := a.applySpec(ctx, sp); err != nil {
				a.log.Warn("aplicar spec de la sincronización", "id", sp.GetServerId(), "err", err)
			}
		}
		for _, id := range b.SyncSpecs.RemovedIds {
			if err := a.rec.Remove(ctx, id, false); err != nil {
				a.log.Warn("eliminar servidor retirado", "id", id, "err", err)
			}
			a.hub.Reset(id)
		}
		a.rec.ReconcileAll(ctx)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_ApplySpec:
		if code, err := a.applySpec(ctx, b.ApplySpec.Server); err != nil {
			_ = send(errMsg(env.Id, code, err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_RemoveServer:
		if err := a.rec.Remove(ctx, b.RemoveServer.ServerId, b.RemoveServer.DeleteData); err != nil {
			_ = send(errMsg(env.Id, "remove_failed", err))
			return
		}
		a.hub.Reset(b.RemoveServer.ServerId)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_PowerAction:
		if err := a.rec.Power(ctx, b.PowerAction.ServerId, b.PowerAction.Action); err != nil {
			_ = send(errMsg(env.Id, "power_failed", err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_SendCommand:
		sp, err := a.st.GetSpec(b.SendCommand.ServerId)
		if err != nil || sp == nil {
			_ = send(errMsg(env.Id, "unknown_server", errors.New("servidor desconocido")))
			return
		}
		parsed, err := spec.Parse(sp.SpecJson)
		if err != nil {
			_ = send(errMsg(env.Id, "bad_spec", err))
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		out, err := a.rcon(cctx, spec.ContainerName(sp.Slug), uint16(spec.RconPort), parsed.RconPassword, b.SendCommand.Command)
		cancel()
		if err != nil {
			_ = send(errMsg(env.Id, "rcon_failed", err))
			return
		}
		_ = send(&mcsmv1.Envelope{Id: env.Id, Body: &mcsmv1.Envelope_CommandResult{CommandResult: &mcsmv1.CommandResult{Output: out}}})

	case *mcsmv1.Envelope_SubscribeLogs:
		a.startLogStream(ctx, env.Id, b.SubscribeLogs, send)

	case *mcsmv1.Envelope_StreamClose:
		a.mu.Lock()
		if s, ok := a.streams[env.StreamId]; ok {
			s.cancel()
			delete(a.streams, env.StreamId)
		}
		a.mu.Unlock()

	default:
		a.log.Warn("mensaje no soportado", "type", fmt.Sprintf("%T", env.Body))
	}
}

func (a *App) startLogStream(parent context.Context, streamID uint64, req *mcsmv1.SubscribeLogs, send func(*mcsmv1.Envelope) error) {
	ctx, cancel := context.WithCancel(parent)
	me := &logStream{cancel: cancel}
	a.mu.Lock()
	if old, ok := a.streams[streamID]; ok {
		old.cancel()
	}
	a.streams[streamID] = me
	a.mu.Unlock()
	_ = send(&mcsmv1.Envelope{Id: streamID, StreamId: streamID, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}})

	go func() {
		defer func() {
			cancel()
			a.mu.Lock()
			if a.streams[streamID] == me { // no borrar un stream que lo reemplazó
				delete(a.streams, streamID)
			}
			a.mu.Unlock()
		}()
		tail := int(req.Tail)
		for ctx.Err() == nil {
			if cid := a.rec.ContainerID(ctx, req.ServerId); cid != "" {
				if sub, err := a.hub.SubscribeSub(req.ServerId, cid, tail); err == nil {
					tail = 0 // tras una reconexión al contenedor no repetimos el histórico
					a.pumpLogs(ctx, streamID, req.ServerId, sub, send)
					sub.Close()
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(retryEvery):
			}
		}
	}()
}

// pumpLogs reenvía las líneas de sub hasta que ctx termina o el follower se cierra.
func (a *App) pumpLogs(ctx context.Context, streamID uint64, serverID string, sub *logs.Subscription, send func(*mcsmv1.Envelope) error) {
	tick := time.NewTicker(droppedEvery)
	defer tick.Stop()
	var reported uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			// El proto aún no tiene StreamDropped: solo se deja constancia en el log.
			if d := sub.Dropped(); d > reported {
				a.log.Warn("líneas de log descartadas por suscriptor lento", "server", serverID, "stream", streamID, "nuevas", d-reported, "total", d)
				reported = d
			}
		case line, ok := <-sub.Lines:
			if !ok {
				return
			}
			_ = send(&mcsmv1.Envelope{StreamId: streamID, Body: &mcsmv1.Envelope_LogLine{LogLine: &mcsmv1.LogLine{
				ServerId: serverID, TsUnixMs: line.TS.UnixMilli(), Line: line.Text,
			}}})
		}
	}
}

func (a *App) cancelAllStreams() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, s := range a.streams {
		s.cancel()
		delete(a.streams, id)
	}
}

func (a *App) eventLoop(ctx context.Context) {
	for ctx.Err() == nil {
		events, errs := a.eng.Events(ctx)
	loop:
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-errs:
				if err != nil && !errors.Is(err, context.Canceled) {
					a.log.Warn("stream de eventos Docker cortado", "err", err)
				}
				break loop
			case ev, ok := <-events:
				if !ok {
					break loop
				}
				id := ev.Labels[spec.LabelServerID]
				if id == "" {
					continue
				}
				if ev.Action == "destroy" {
					a.hub.Reset(id)
				}
				switch ev.Action {
				case "start", "die", "stop", "kill", "destroy", "oom", "health_status: healthy", "health_status: unhealthy", "restart":
					a.rec.Observe(ctx, id)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryEvery):
		}
	}
}

func (a *App) tickers(ctx context.Context) {
	observe := time.NewTicker(observeEvery)
	reconcileT := time.NewTicker(reconcileEvery)
	defer observe.Stop()
	defer reconcileT.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-observe.C:
			specs, _ := a.st.ListSpecs()
			for _, sp := range specs {
				a.rec.Observe(ctx, sp.ServerId)
			}
		case <-reconcileT.C:
			a.rec.ReconcileAll(ctx)
		}
	}
}
