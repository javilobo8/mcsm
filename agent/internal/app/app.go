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
	helloDockerTTL = 5 * time.Second
	maxConcurrent  = 16 // operaciones de fondo simultáneas (observar/reconciliar) en todo el nodo
)

// logStream es un stream de logs abierto por el panel.
type logStream struct {
	cancel context.CancelFunc
	done   chan struct{} // se cierra cuando la goroutine del stream termina
}

// flight es el estado de una tarea de fondo por servidor: en curso y, si llegó otra
// petición mientras tanto, pendiente de repetir una sola vez (coalescida).
type flight struct{ pending bool }

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

	// send debe fijarse antes de lanzar goroutines (Run) o antes de usar la App (tests);
	// después es de solo lectura. Por eso se lee sin lock.
	send func(*mcsmv1.Envelope) error

	mu      sync.Mutex // protege streams
	streams map[uint64]*logStream

	fmu     sync.Mutex // protege flights
	flights map[string]*flight
	sem     chan struct{}
}

// New construye la aplicación. send se fija después (Run) o en tests.
func New(cfg Config, st *store.Store, eng docker.Engine, log *slog.Logger) *App {
	a := &App{cfg: cfg, st: st, eng: eng, log: log, status: mc.Status, rcon: mc.Rcon, streams: map[uint64]*logStream{},
		flights: map[string]*flight{}, sem: make(chan struct{}, maxConcurrent)}
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
			log.Error("el panel rechazó el token del nodo (401): el nodo pudo ser borrado o su token rotado; borra el volumen de AGENT_DATA y vuelve a darlo de alta con un token nuevo (ENROLL_TOKEN se ignora mientras haya credenciales guardadas)")
		},
	})
	a.send = func(e *mcsmv1.Envelope) error { return client.Send(ctx, e) }

	go a.eventLoop(ctx)
	go a.tickers(ctx)
	// §6.1: primero el WS; la primera pasada de reconciliación va en segundo plano.
	go a.reconcileAll(ctx)
	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	// ── plan-5 ──
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	// ── plan-9 ──
	client.Run(ctx)
	return nil
}

func (a *App) hello(ctx context.Context) *mcsmv1.Hello {
	vers, _ := a.st.SpecVersions()
	vctx, cancel := context.WithTimeout(ctx, helloDockerTTL)
	dv, _ := a.eng.Version(vctx)
	cancel()
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
func (a *App) applySpec(ctx context.Context, sp *mcsmv1.ServerSpec, force bool) (code string, err error) {
	if sp == nil || sp.ServerId == "" || !spec.ValidSlug(sp.Slug) {
		return "invalid_spec", errors.New("spec inválida: server_id o slug no válido")
	}
	apply := a.rec.Apply
	if force {
		apply = a.rec.ApplyForce
	}
	if err := apply(ctx, sp); err != nil {
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
			if _, err := a.applySpec(ctx, sp, true); err != nil { // el panel es la verdad al reconectar
				a.log.Warn("aplicar spec de la sincronización", "id", sp.GetServerId(), "err", err)
			}
		}
		for _, id := range b.SyncSpecs.RemovedIds {
			if err := a.rec.Remove(ctx, id, false); err != nil {
				a.log.Warn("eliminar servidor retirado", "id", id, "err", err)
				continue
			}
			a.hub.Reset(id)
		}
		a.reconcileAll(ctx)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_ApplySpec:
		if code, err := a.applySpec(ctx, b.ApplySpec.Server, false); err != nil {
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
		if sp, err := a.st.GetSpec(b.SubscribeLogs.ServerId); err != nil || sp == nil {
			_ = send(errMsg(env.Id, "unknown_server", errors.New("servidor desconocido")))
			return
		}
		a.startLogStream(ctx, env.Id, b.SubscribeLogs, send)

	case *mcsmv1.Envelope_StreamClose:
		a.mu.Lock()
		if s, ok := a.streams[env.StreamId]; ok {
			s.cancel()
			delete(a.streams, env.StreamId)
		}
		a.mu.Unlock()

	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	// ── plan-5 ──
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	// ── plan-9 ──

	default:
		a.log.Warn("mensaje no soportado", "type", fmt.Sprintf("%T", env.Body))
		if env.Id != 0 {
			_ = send(errMsg(env.Id, "unsupported", fmt.Errorf("mensaje no soportado: %T", env.Body)))
		}
	}
}

func (a *App) startLogStream(parent context.Context, streamID uint64, req *mcsmv1.SubscribeLogs, send func(*mcsmv1.Envelope) error) {
	ctx, cancel := context.WithCancel(parent)
	me := &logStream{cancel: cancel, done: make(chan struct{})}
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
			defer close(me.done)
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
					a.observeAsync(ctx, id)
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
				a.observeAsync(ctx, sp.ServerId)
			}
		case <-reconcileT.C:
			a.reconcileAll(ctx)
		}
	}
}

// observeAsync observa un servidor sin bloquear al llamador: un servidor en una
// operación larga (pull, stop de 60 s) solo retiene su propia tarea.
func (a *App) observeAsync(ctx context.Context, id string) {
	a.dispatch(ctx, "obs:"+id, func() { a.rec.Observe(ctx, id) })
}

// reconcileAll reconcilia cada servidor por separado y sin esperar a ninguno.
func (a *App) reconcileAll(ctx context.Context) {
	specs, err := a.st.ListSpecs()
	if err != nil {
		a.log.Error("listar specs", "err", err)
		return
	}
	for _, sp := range specs {
		id, slug := sp.ServerId, sp.Slug
		a.dispatch(ctx, "rec:"+id, func() {
			if err := a.rec.ReconcileTick(ctx, id); err != nil {
				a.log.Warn("reconciliar", "server", slug, "err", err)
			}
		})
	}
}

// dispatch ejecuta fn en una goroutine con concurrencia acotada. Si ya hay una tarea
// con la misma clave en curso no se apila otra: se anota una repetición pendiente.
func (a *App) dispatch(ctx context.Context, key string, fn func()) {
	a.fmu.Lock()
	if f, ok := a.flights[key]; ok {
		f.pending = true
		a.fmu.Unlock()
		return
	}
	f := &flight{}
	a.flights[key] = f
	a.fmu.Unlock()
	go func() {
		for {
			select {
			case a.sem <- struct{}{}:
				fn()
				<-a.sem
			case <-ctx.Done():
			}
			a.fmu.Lock()
			if f.pending && ctx.Err() == nil {
				f.pending = false
				a.fmu.Unlock()
				continue
			}
			delete(a.flights, key)
			a.fmu.Unlock()
			return
		}
	}()
}
