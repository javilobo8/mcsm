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
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/mem"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/conn"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/logs"
	"mcsm/agent/internal/mc"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/router"
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
	// life es el contexto de vida del agente (el de Run). Las operaciones que mutan
	// Docker o disco lo usan en vez del de la sesión WS: un corte de la conexión no
	// debe dejar a medias un recreado ni un borrado. Mismo régimen que send.
	life context.Context

	mu      sync.Mutex // protege streams
	streams map[uint64]*logStream

	fmu     sync.Mutex // protege flights y forced
	flights map[string]*flight
	forced  map[string]bool // reconciliaciones pedidas sin backoff (SyncSpecs), pendientes de ejecutar
	sem     chan struct{}
	bg      sync.WaitGroup // tareas de fondo (sincronización y despachos)

	xfer transferGate // transferencias de archivos en curso (files.go)
	// fileWrites: mutaciones de archivos en curso por servidor; una restauración las espera
	// tras reservar el servidor (integración de los Planes 4 y 5, ver filewrites.go).
	fileWrites fileWrites
	bk         *backupService // plan-4: copias, restauraciones, jobs y programación
	// plan-8: mc-router del nodo (router.go).
	router *router.Manager
}

// New construye la aplicación. send se fija después (Run) o en tests.
func New(cfg Config, st *store.Store, eng docker.Engine, log *slog.Logger) *App {
	a := &App{cfg: cfg, st: st, eng: eng, log: log, status: mc.Status, rcon: mc.Rcon, streams: map[uint64]*logStream{},
		flights: map[string]*flight{}, forced: map[string]bool{}, sem: make(chan struct{}, maxConcurrent), life: context.Background()}
	a.send = func(*mcsmv1.Envelope) error { return conn.ErrNotConnected }
	a.rec = reconcile.New(st, eng, cfg.DataRoot, cfg.Network, func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
		return a.status(ctx, host, port)
	}, a.onObserved)
	a.hub = logs.NewHub(eng)
	a.bk = newBackupService(a, backup.RealClock) // plan-4
	// plan-8: mc-router del nodo; con su autoscale, los servidores con hostname van bajo demanda.
	a.router = router.New(eng, st, router.Options{Name: cfg.RouterName, Network: cfg.Network})
	a.rec.SetOnDemand(a.onDemand)
	return a
}

// Run es el punto de entrada del binario.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	// §6.1: sin el montaje espejo de DATA_ROOT el agente trabajaría sobre su propio
	// contenedor sin enterarse; mejor no arrancar.
	if err := checkDataRoot(cfg.DataRoot, hostProbe, log); err != nil {
		return err
	}
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
	a.life = ctx
	// plan-4 (fuera de ancla: tiene que ir antes de la primera reconciliación y de aceptar
	// jobs): save-on y jobs que un cierre o crash dejó a medias, y el disco de cada servidor.
	// Una restauración interrumpida puede dejar un servidor sin data, y reconcileAll lo
	// arrancaría con un mundo nuevo.
	a.bk.recoverAtStart(ctx)

	go a.eventLoop(ctx)
	go a.tickers(ctx)
	// §6.1: primero el WS; la primera pasada de reconciliación va en segundo plano.
	go a.reconcileAll(ctx)
	// ── plan-2 ──
	go a.runMetrics(ctx)
	// ── plan-3 ──
	// ── plan-4 ──
	a.bk.start(ctx)
	// ── plan-5 ──
	go a.sweepTemps(ctx) // temporales huérfanos de subidas cortadas (kill -9, corte de luz)
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	go a.routerLoop(ctx)
	// ── plan-9 ──
	client.Run(ctx)
	// Cierre (ctx ya cancelado), las dos esperas EN PARALELO para que el total no pase de
	// shutdownWait (25 s < stop_grace_period de 30 s):
	//   - los Files* en curso (ya cortados por ctx) terminan de limpiar sus temporales;
	//   - plan-4: las copias en curso abortan y su defer envía save-on.
	waitAll(
		func() bool {
			if !a.xfer.wait(filesShutdownWait) {
				log.Warn("cierre sin esperar a las operaciones de archivos en curso: venció el plazo", "plazo", filesShutdownWait)
				return false
			}
			return true
		},
		func() bool { return a.bk.wait(shutdownWait) },
	)
	return nil
}

func (a *App) hello(ctx context.Context) *mcsmv1.Hello {
	specs, err := a.st.ListSpecs()
	if err != nil {
		a.log.Error("listar specs para el Hello", "err", err)
	}
	vers := make(map[string]uint64, len(specs))
	desired := make(map[string]mcsmv1.DesiredState, len(specs))
	for _, sp := range specs {
		vers[sp.ServerId] = sp.Version
		desired[sp.ServerId] = sp.DesiredState
	}
	vctx, cancel := context.WithTimeout(ctx, helloDockerTTL)
	dv, _ := a.eng.Version(vctx)
	cancel()
	host, _ := os.Hostname()
	info := &mcsmv1.HostInfo{Hostname: host, Cpus: uint32(runtime.NumCPU()), Os: runtime.GOOS, Arch: runtime.GOARCH}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemTotalBytes = vm.Total
	}
	return &mcsmv1.Hello{AgentVersion: a.cfg.Version, DockerVersion: dv, Host: info, SpecVersions: vers, DesiredStates: desired}
}

// onObserved se invoca con el lock por servidor tomado: no puede llamar al reconciliador.
func (a *App) onObserved(serverID string, obs *mcsmv1.Observed) {
	a.bk.players.Observe(serverID, obs.GetMc().GetPlayersOnline()) // plan-4: onlyIfPlayersSince (solo su propio mutex)
	_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_ServerObserved{ServerObserved: &mcsmv1.ServerObserved{
		ServerId: serverID, Observed: obs, TsUnixMs: time.Now().UnixMilli(),
	}}})
}

// validUTF8 sanea texto que viene del contenedor: proto3 rechaza string con UTF-8
// inválido (el truncado por bytes puede partir una runa, o la salida no es UTF-8) y
// proto.Marshal fallaría, perdiendo el mensaje en silencio.
func validUTF8(s string) string { return strings.ToValidUTF8(s, "\uFFFD") }

func ack(id uint64) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}
}

func errMsg(id uint64, code string, err error) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: code, Message: err.Error()}}}
}

// validSpecMsg comprueba lo mínimo para guardar una spec del panel: server_id y slug
// (el slug acaba en rutas de disco y nombres de contenedor).
func validSpecMsg(sp *mcsmv1.ServerSpec) error {
	if sp == nil || sp.ServerId == "" || !spec.ValidSlug(sp.Slug) {
		return errors.New("spec inválida: server_id o slug no válido")
	}
	return nil
}

// applySpec valida y aplica una spec del panel (guarda de versión incluida en el reconciliador).
func (a *App) applySpec(ctx context.Context, sp *mcsmv1.ServerSpec) (code string, err error) {
	if err := validSpecMsg(sp); err != nil {
		return errcode.InvalidSpec, err
	}
	if err := a.rec.Apply(ctx, sp); err != nil {
		return busyOr(err, errcode.ApplyFailed), err
	}
	return "", nil
}

// busyOr devuelve errcode.Busy (409 en el panel) si err es un servidor ocupado o reservado
// (reconcile.ErrBusy: copia, restauración o bloqueado sin datos), y fallback en otro caso.
func busyOr(err error, fallback string) string {
	if errors.Is(err, reconcile.ErrBusy) {
		return errcode.Busy
	}
	return fallback
}

// syncSpecs aplica la foto del panel al reconectar (spec §3: el panel es la verdad).
//
//  1. removed_ids primero: se borra su spec del store (nada puede resucitarlos).
//  2. Se guardan forzadas todas las specs recibidas, sin guarda de versión (la BD del
//     panel pudo restaurarse) y sin reconciliar en línea.
//  3. Ack inmediato: el panel retiene el resto de peticiones hasta recibirlo
//     (AgentConn.ready), así que esta fase solo toca el store.
//  4. En segundo plano y con el contexto de vida: se paran y borran los contenedores
//     retirados y, después (un slug borrado y recreado sin conexión reutiliza el
//     nombre del contenedor), se reconcilia cada servidor recibido sin backoff.
//
// Un ApplySpec posterior con versión mayor gana: Apply mantiene su guarda de versión y
// la reconciliación de fondo lee siempre la spec vigente del store.
func (a *App) syncSpecs(id uint64, req *mcsmv1.SyncSpecs, send func(*mcsmv1.Envelope) error) {
	life := a.life
	var removed, synced []string
	for _, sid := range req.RemovedIds {
		if err := a.rec.Forget(sid); err != nil {
			a.log.Warn("olvidar servidor retirado", "id", sid, "err", err)
			continue
		}
		removed = append(removed, sid)
	}
	for _, sp := range req.Servers {
		if err := validSpecMsg(sp); err != nil {
			a.log.Warn("spec de la sincronización ignorada", "id", sp.GetServerId(), "err", err)
			continue
		}
		if err := a.rec.StoreForce(sp); err != nil {
			a.log.Warn("guardar spec de la sincronización", "id", sp.ServerId, "err", err)
			continue
		}
		synced = append(synced, sp.ServerId)
	}
	_ = send(ack(id))

	a.bg.Add(1)
	go func() {
		defer a.bg.Done()
		var wg sync.WaitGroup
		for _, sid := range removed {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := a.rec.Remove(life, sid, false); err != nil {
					a.log.Warn("eliminar servidor retirado", "id", sid, "err", err)
					return
				}
				a.hub.Reset(sid)
			}()
		}
		wg.Wait()
		for _, sid := range synced {
			a.reconcileAsync(life, sid, true)
		}
	}()
}

// Handle implementa conn.Handler. ctx es el de la sesión WS: solo vale para lo ligado a
// ella (streams, RCON). Lo que muta Docker o disco usa a.life.
func (a *App) Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	life := a.life
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_HelloAck:
		a.log.Info("panel confirmó la sesión", "node_id", b.HelloAck.NodeId)

	case *mcsmv1.Envelope_SyncSpecs:
		a.syncSpecs(env.Id, b.SyncSpecs, send)

	case *mcsmv1.Envelope_ApplySpec:
		if code, err := a.applySpec(life, b.ApplySpec.Server); err != nil {
			_ = send(errMsg(env.Id, code, err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_RemoveServer:
		if err := a.rec.Remove(life, b.RemoveServer.ServerId, b.RemoveServer.DeleteData); err != nil {
			_ = send(errMsg(env.Id, busyOr(err, errcode.RemoveFailed), err))
			return
		}
		a.hub.Reset(b.RemoveServer.ServerId)
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_PowerAction:
		if err := a.rec.Power(life, b.PowerAction.ServerId, b.PowerAction.Action); err != nil {
			_ = send(errMsg(env.Id, busyOr(err, errcode.PowerFailed), err))
			return
		}
		_ = send(ack(env.Id))

	case *mcsmv1.Envelope_SendCommand:
		sp, err := a.st.GetSpec(b.SendCommand.ServerId)
		if err != nil || sp == nil {
			_ = send(errMsg(env.Id, errcode.UnknownServer, errors.New("servidor desconocido")))
			return
		}
		parsed, err := spec.Parse(sp.SpecJson)
		if err != nil {
			_ = send(errMsg(env.Id, errcode.BadSpec, err))
			return
		}
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		out, err := a.rcon(cctx, spec.ContainerName(sp.Slug), uint16(spec.RconPort), parsed.RconPassword, b.SendCommand.Command)
		cancel()
		if err != nil {
			_ = send(errMsg(env.Id, errcode.RconFailed, err))
			return
		}
		_ = send(&mcsmv1.Envelope{Id: env.Id, Body: &mcsmv1.Envelope_CommandResult{CommandResult: &mcsmv1.CommandResult{Output: validUTF8(out)}}})

	case *mcsmv1.Envelope_SubscribeLogs:
		if sp, err := a.st.GetSpec(b.SubscribeLogs.ServerId); err != nil || sp == nil {
			_ = send(errMsg(env.Id, errcode.UnknownServer, errors.New("servidor desconocido")))
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

	case *mcsmv1.Envelope_Ack, *mcsmv1.Envelope_Error:
		// El agente no hace peticiones al panel: nada espera estas respuestas, y contestar
		// un Error con otro Error podría encadenar un bucle. Se ignoran.
		a.log.Debug("respuesta del panel ignorada", "type", fmt.Sprintf("%T", env.Body), "id", env.Id)

	// ── plan-2 ──
	// ── plan-3 ──
	// ── plan-4 ──
	case *mcsmv1.Envelope_BackupNow:
		a.bk.handleBackupNow(env.Id, b.BackupNow, send)
	case *mcsmv1.Envelope_BackupRestore:
		a.bk.handleBackupRestore(env.Id, b.BackupRestore, send)
	case *mcsmv1.Envelope_BackupDelete:
		a.bk.handleBackupDelete(env.Id, b.BackupDelete, send)
	case *mcsmv1.Envelope_BackupList:
		a.bk.handleBackupList(env.Id, b.BackupList, send)
	// ── plan-5 ──
	case *mcsmv1.Envelope_FilesList, *mcsmv1.Envelope_FilesStat, *mcsmv1.Envelope_FilesRead,
		*mcsmv1.Envelope_FilesWrite, *mcsmv1.Envelope_FilesMkdir, *mcsmv1.Envelope_FilesRename,
		*mcsmv1.Envelope_FilesDelete, *mcsmv1.Envelope_FilesDownload, *mcsmv1.Envelope_FilesUpload:
		// Disco y transferencias con el contexto de vida: un corte del WS no los aborta.
		a.handleFiles(life, env, send)
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	case *mcsmv1.Envelope_RouterApply:
		a.handleRouterApply(env.Id, b.RouterApply, send)
	case *mcsmv1.Envelope_RouterRemove:
		a.handleRouterRemove(env.Id, send)
	// ── plan-9 ──

	default:
		// Body nil: un panel más nuevo envió un cuerpo que este agente no conoce (protobuf lo
		// deja en campos desconocidos). Si no, es un cuerpo conocido que el panel no envía.
		msg := "mensaje desconocido: actualiza el agente"
		if env.Body != nil {
			msg = fmt.Sprintf("mensaje no soportado por el agente: %T", env.Body)
		}
		a.log.Warn(msg, "id", env.Id)
		if env.Id != 0 {
			_ = send(errMsg(env.Id, errcode.Unsupported, errors.New(msg)))
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
				ServerId: serverID, TsUnixMs: line.TS.UnixMilli(), Line: validUTF8(line.Text),
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
				if isRouterEvent(ev.Labels) { // plan-8: el contenedor del router
					a.routerEvent(ctx, ev.Action)
					continue
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

// reconcileAll ejecuta una pasada de reconciliación sin bloquear al llamador. Primero
// reintenta los borrados pendientes de servidores retirados (lápidas; acotados por pasada
// y con backoff en el reconciliador): un slug retirado y recreado con otro id reutiliza el
// nombre del contenedor. Después reconcilia cada servidor por separado y sin esperar a
// ninguno.
func (a *App) reconcileAll(ctx context.Context) {
	a.dispatch(ctx, "reconcile-all", func() {
		for _, id := range a.rec.RetryRemovals(ctx) {
			a.hub.Reset(id)
		}
		specs, err := a.st.ListSpecs()
		if err != nil {
			a.log.Error("listar specs", "err", err)
			return
		}
		for _, sp := range specs {
			a.reconcileAsync(ctx, sp.ServerId, false)
		}
	})
}

// reconcileAsync reconcilia un servidor con el despachador por servidor. Con force se
// salta el backoff (SyncSpecs); la marca se consume al ejecutar, así que sobrevive a la
// coalescencia con un tick que ya estaba en curso.
func (a *App) reconcileAsync(ctx context.Context, id string, force bool) {
	if force {
		a.fmu.Lock()
		a.forced[id] = true
		a.fmu.Unlock()
	}
	a.dispatch(ctx, "rec:"+id, func() {
		a.fmu.Lock()
		forced := a.forced[id]
		delete(a.forced, id)
		a.fmu.Unlock()
		var err error
		if forced {
			err = a.rec.Reconcile(ctx, id)
		} else {
			err = a.rec.ReconcileTick(ctx, id)
		}
		if err != nil {
			a.log.Warn("reconciliar", "server", id, "err", err)
		}
	})
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
	a.bg.Add(1)
	go func() {
		defer a.bg.Done()
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

// waitAll ejecuta a la vez las esperas del cierre (cada una con su propio tope) y vuelve
// cuando han terminado todas: el total es el mayor de los topes, no la suma. false si
// alguna venció su plazo.
func waitAll(waits ...func() bool) bool {
	results := make(chan bool, len(waits))
	for _, w := range waits {
		go func() { results <- w() }()
	}
	ok := true
	for range waits {
		ok = <-results && ok
	}
	return ok
}
