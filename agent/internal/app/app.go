// Package app wires together all the agent's pieces.
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
	"mcsm/agent/internal/crashloop"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/dockerproxy"
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
	maxConcurrent  = 16 // simultaneous background operations (observe/reconcile) across the whole node
)

// logStream is a log stream opened by the panel.
type logStream struct {
	cancel context.CancelFunc
	done   chan struct{} // closed when the stream's goroutine ends
}

// flight is the state of a per-server background task: in progress and, if another
// request arrived in the meantime, pending a single repeat (coalesced).
type flight struct{ pending bool }

// App is the complete agent: reconciler, log hub and panel messages.
type App struct {
	cfg    Config
	st     *store.Store
	eng    docker.Engine
	rec    *reconcile.Reconciler
	hub    *logs.Hub
	log    *slog.Logger
	status mc.StatusFunc
	rcon   func(ctx context.Context, host string, port uint16, password, command string) (string, error)

	// send must be set before launching goroutines (Run) or before using the App (tests);
	// afterwards it is read-only. That is why it is read without a lock.
	send func(*mcsmv1.Envelope) error
	// life is the agent's life context (Run's). Operations that mutate
	// Docker or disk use it instead of the WS session's: a connection drop must
	// not leave a recreation or a deletion half done. Same regime as send.
	life context.Context

	mu      sync.Mutex // protege streams
	streams map[uint64]*logStream

	fmu     sync.Mutex // protege flights y forced
	flights map[string]*flight
	forced  map[string]bool // reconciliations requested without backoff (SyncSpecs), pending execution
	sem     chan struct{}
	bg      sync.WaitGroup // background tasks (synchronization and dispatches)

	xfer transferGate // file transfers in progress (files.go)
	// fileWrites: file mutations in progress per server; a restore waits for them
	// after reserving the server (integration of Plans 4 and 5, see filewrites.go).
	fileWrites fileWrites
	bk         *backupService // plan-4: backups, restores, jobs and scheduling
	// plan-8: the node's mc-router (router.go).
	router *router.Manager
	proxy  *dockerproxy.Proxy // plan-9: filtered Docker socket for the router
	// plan-9: events for the panel (Event), in their own FIFO queue; crash loops.
	events  *outbox
	crashes *crashloop.Tracker
	intents *crashloop.Intents
	// stopMu protects crashStops: the last loop stop decided per server, pending execution. dispatch
	// merges the firings of the same server; the execution always reads the last decision (plan-9, N1).
	stopMu     sync.Mutex
	crashStops map[string]crashStop
	// plan-9: RotateToken. Run connects them to the WS client; in tests they are no-ops or fakes.
	setToken  func(string)
	reconnect func()
	rotateMu  sync.Mutex // serializes RotateToken: saving, setToken, Ack and reconnecting go together
}

// New builds the application. send is set later (Run) or in tests.
func New(cfg Config, st *store.Store, eng docker.Engine, log *slog.Logger) *App {
	// plan-9 (outside anchor): all the pieces use the wrapped engine, which records the stops the agent requests
	// so as not to count them as crashes.
	intents := crashloop.NewIntents(time.Now)
	eng = crashloop.Engine{Engine: eng, Intents: intents}
	a := &App{cfg: cfg, st: st, eng: eng, log: log, status: mc.Status, rcon: mc.Rcon, streams: map[uint64]*logStream{},
		flights: map[string]*flight{}, forced: map[string]bool{}, sem: make(chan struct{}, maxConcurrent), life: context.Background(),
		intents: intents, crashes: crashloop.NewTracker(time.Now), crashStops: map[string]crashStop{}, setToken: func(string) {}, reconnect: func() {}}
	a.send = func(*mcsmv1.Envelope) error { return conn.ErrNotConnected }
	a.rec = reconcile.New(st, eng, cfg.DataRoot, cfg.Network, func(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
		return a.status(ctx, host, port)
	}, a.onObserved)
	a.hub = logs.NewHub(eng)
	a.hub.SetSecrets(a.logSecrets)               // plan-9
	a.bk = newBackupService(a, backup.RealClock) // plan-4
	// plan-8: the node's mc-router; with its autoscale, servers with a hostname are on-demand.
	// plan-9 (outside anchor): the router mounts the proxy socket, not Docker's.
	a.proxy = dockerproxy.New(dockerproxy.Options{Listen: proxySocketPath(cfg.DataRoot), Upstream: router.HostSocket,
		Policy: a.routerPolicy, UID: 65532, GID: 65532, Log: log})
	a.router = router.New(eng, st, router.Options{Name: cfg.RouterName, Network: cfg.Network, FilesDir: routerFilesDir(cfg.DataRoot),
		ProxySocket: proxySocketPath(cfg.DataRoot), ProxyReady: a.proxy.Ready})
	a.rec.SetOnDemand(a.onDemand)
	// plan-9: Event queue (a.send is read on delivery) and the reconciler's drift, without blocking its lock.
	a.events = newOutbox(func(e *mcsmv1.Envelope) error { return a.send(e) }, outboxSize, log, "events for the panel (Event)")
	a.rec.SetEventSink(func(id, kind, msg string) { a.emitEvent(id, mcsmv1.EventLevel_EVENT_LEVEL_WARN, kind, msg) })
	// plan-9: starting by hand starts the crash count from zero, only if Power accepts the action (not if it replies
	// busy) and before the Docker action: an error exit while starting is not added to the earlier ones.
	a.rec.SetOnManualStart(a.crashes.Reset)
	return a
}

// Run is the binary's entry point.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	// §6.1: without the mirror mount of DATA_ROOT the agent would work on its own
	// container without noticing; better not to start.
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
		return fmt.Errorf("cannot talk to Docker (is /var/run/docker.sock mounted?): %w", err)
	}
	if err := eng.EnsureNetwork(ctx, cfg.Network); err != nil {
		return fmt.Errorf("create network %s: %w", cfg.Network, err)
	}

	// Spec §6.1: it only enrolls if there is no stored token.
	creds, err := st.Credentials()
	if err != nil {
		return err
	}
	if creds == nil {
		if cfg.EnrollToken == "" {
			return errors.New("this agent is not enrolled: set ENROLL_TOKEN (generated in Nodes → Add node)")
		}
		log.Info("enrolling the node with the panel", "panel", cfg.PanelURL)
		res, err := conn.Enroll(ctx, cfg.PanelURL, cfg.EnrollToken, cfg.NameHint, cfg.Version)
		if err != nil {
			return err
		}
		creds = &store.Credentials{NodeID: res.NodeID, Token: res.NodeToken}
		if err := st.SaveCredentials(*creds); err != nil {
			return err
		}
		log.Info("node enrolled", "node_id", res.NodeID)
	}

	a := New(cfg, st, eng, log)
	client := conn.NewClient(conn.Options{
		PanelURL: cfg.PanelURL, Token: creds.Token, Hello: a.hello, Handler: a, Log: log,
		OnDisconnect: a.cancelAllStreams,
		OnAuthRejected: func() {
			log.Error("the panel rejected the node's token (401): the node may have been deleted or its token rotated; delete the AGENT_DATA volume and enroll it again with a new token (ENROLL_TOKEN is ignored while there are stored credentials)")
		},
	})
	a.send = func(e *mcsmv1.Envelope) error { return client.Send(ctx, e) }
	a.setToken, a.reconnect = client.SetToken, client.Reconnect // plan-9 (outside anchor): RotateToken
	a.life = ctx
	// plan-4 (outside anchor: it has to go before the first reconciliation and before accepting
	// jobs): save-on and jobs that a shutdown or crash left half done, and each server's disk.
	// An interrupted restore can leave a server without data, and reconcileAll would
	// start it with a new world.
	a.bk.recoverAtStart(ctx)

	// plan-9: without the proxy the router is not deployed (error in its state). The first Listen goes before the router's
	// first pass; if it fails, Run retries with backoff and deploys the router as soon as it listens.
	if err := a.proxy.Listen(); err != nil {
		log.Error("Docker socket proxy for the router; retrying", "err", err)
	}
	go a.proxy.Run(ctx, func() { a.routerAsync(ctx) })
	go a.eventLoop(ctx)
	go a.tickers(ctx)
	// §6.1: the WS first; the first reconciliation pass runs in the background.
	go a.reconcileAll(ctx)
	// ── plan-2 ──
	go a.runMetrics(ctx)
	// ── plan-3 ──
	// ── plan-4 ──
	a.bk.start(ctx)
	// ── plan-5 ──
	go a.sweepTemps(ctx) // orphaned temporaries of interrupted uploads (kill -9, power cut)
	// ── plan-6 ──
	// ── plan-7 ──
	// ── plan-8 ──
	go a.routerLoop(ctx)
	// ── plan-9 ──
	go a.events.run(ctx)
	client.Run(ctx)
	// Shutdown (ctx already cancelled), the two waits IN PARALLEL so that the total does not exceed
	// shutdownWait (25 s < stop_grace_period of 30 s):
	//   - the Files* in progress (already cut by ctx) finish cleaning their temporaries;
	//   - plan-4: the backups in progress abort and their defer sends save-on.
	waitAll(
		func() bool {
			if !a.xfer.wait(filesShutdownWait) {
				log.Warn("shutting down without waiting for the file operations in progress: the deadline expired", "deadline", filesShutdownWait)
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
		a.log.Error("list specs for the Hello", "err", err)
	}
	vers := make(map[string]uint64, len(specs))
	desired := make(map[string]mcsmv1.DesiredState, len(specs))
	for _, sp := range specs {
		vers[sp.ServerId] = sp.Version
		desired[sp.ServerId] = sp.DesiredState
	}
	vctx, cancel := context.WithTimeout(ctx, helloDockerTTL)
	dv, _ := a.eng.Version(vctx)
	host, herr := a.eng.HostName(vctx) // plan-9: the daemon's host, not the agent container's id
	cancel()
	if herr != nil || host == "" {
		host, _ = os.Hostname()
	}
	info := &mcsmv1.HostInfo{Hostname: host, Cpus: uint32(runtime.NumCPU()), Os: runtime.GOOS, Arch: runtime.GOARCH}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		info.MemTotalBytes = vm.Total
	}
	return &mcsmv1.Hello{AgentVersion: a.cfg.Version, DockerVersion: dv, Host: info, SpecVersions: vers, DesiredStates: desired}
}

// onObserved is invoked with the per-server lock held: it cannot call the reconciler.
func (a *App) onObserved(serverID string, obs *mcsmv1.Observed) {
	a.bk.players.Observe(serverID, obs.GetMc().GetPlayersOnline()) // plan-4: onlyIfPlayersSince (only its own mutex)
	_ = a.send(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_ServerObserved{ServerObserved: &mcsmv1.ServerObserved{
		ServerId: serverID, Observed: obs, TsUnixMs: time.Now().UnixMilli(),
	}}})
}

// validUTF8 sanitizes text coming from the container: proto3 rejects strings with
// invalid UTF-8 (truncating by bytes can split a rune, or the output is not UTF-8) and
// proto.Marshal would fail, silently losing the message.
func validUTF8(s string) string { return strings.ToValidUTF8(s, "\uFFFD") }

func ack(id uint64) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}
}

func errMsg(id uint64, code string, err error) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: code, Message: err.Error()}}}
}

// validSpecMsg checks the minimum to store a spec from the panel: server_id and slug
// (the slug ends up in disk paths and container names).
func validSpecMsg(sp *mcsmv1.ServerSpec) error {
	if sp == nil || sp.ServerId == "" || !spec.ValidSlug(sp.Slug) {
		return errors.New("invalid spec: invalid server_id or slug")
	}
	return nil
}

// applySpec validates and applies a spec from the panel (version guard included in the reconciler).
func (a *App) applySpec(ctx context.Context, sp *mcsmv1.ServerSpec) (code string, err error) {
	if err := validSpecMsg(sp); err != nil {
		return errcode.InvalidSpec, err
	}
	if err := a.rec.Apply(ctx, sp); err != nil {
		if errors.Is(err, reconcile.ErrDataPathUnverified) { // plan-6 (H1): a dataPath the agent did not verify
			return errcode.BadSpec, err
		}
		return busyOr(err, errcode.ApplyFailed), err
	}
	return "", nil
}

// busyOr returns errcode.Busy (409 in the panel) if err is a busy or reserved server
// (reconcile.ErrBusy: backup, restore or locked without data), and fallback otherwise.
func busyOr(err error, fallback string) string {
	if errors.Is(err, reconcile.ErrBusy) {
		return errcode.Busy
	}
	return fallback
}

// syncSpecs applies the panel's snapshot on reconnecting (spec §3: the panel is the truth).
//
//  1. removed_ids first: their spec is deleted from the store (nothing can resurrect them).
//  2. All the received specs are stored forced, without a version guard (the panel's
//     DB may have been restored) and without reconciling inline.
//  3. Immediate Ack: the panel holds back the rest of the requests until it receives it
//     (AgentConn.ready), so this phase only touches the store.
//  4. In the background and with the life context: the withdrawn containers are stopped and
//     deleted and, afterwards (a slug deleted and recreated while offline reuses the
//     container name), each received server is reconciled without backoff.
//
// A later ApplySpec with a higher version wins: Apply keeps its version guard and
// the background reconciliation always reads the current spec from the store.
func (a *App) syncSpecs(id uint64, req *mcsmv1.SyncSpecs, send func(*mcsmv1.Envelope) error) {
	life := a.life
	var removed, synced []string
	for _, sid := range req.RemovedIds {
		if err := a.rec.Forget(sid); err != nil {
			a.log.Warn("forget withdrawn server", "id", sid, "err", err)
			continue
		}
		removed = append(removed, sid)
	}
	for _, sp := range req.Servers {
		if err := validSpecMsg(sp); err != nil {
			a.log.Warn("sync spec ignored", "id", sp.GetServerId(), "err", err)
			continue
		}
		if err := a.rec.StoreForce(sp); err != nil {
			a.log.Warn("store sync spec", "id", sp.ServerId, "err", err)
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
					a.log.Warn("remove withdrawn server", "id", sid, "err", err)
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

// Handle implements conn.Handler. ctx is the WS session's: it is only good for what is tied to
// it (streams, RCON). What mutates Docker or disk uses a.life.
func (a *App) Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	life := a.life
	switch b := env.Body.(type) {
	case *mcsmv1.Envelope_HelloAck:
		a.log.Info("panel confirmed the session", "node_id", b.HelloAck.NodeId)

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
			_ = send(errMsg(env.Id, errcode.UnknownServer, errors.New("unknown server")))
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
			_ = send(errMsg(env.Id, errcode.UnknownServer, errors.New("unknown server")))
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
		// The agent makes no requests to the panel: nothing waits for these responses, and replying
		// to an Error with another Error could chain into a loop. They are ignored.
		a.log.Debug("panel response ignored", "type", fmt.Sprintf("%T", env.Body), "id", env.Id)

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
		// Disk and transfers with the life context: a WS drop does not abort them.
		a.handleFiles(life, env, send)
	// ── plan-6 ──
	case *mcsmv1.Envelope_ImportScan:
		a.handleImportScan(ctx, env.Id, send) // read-only: session context
	case *mcsmv1.Envelope_ImportAdopt:
		a.handleImportAdopt(env.Id, b.ImportAdopt, send) // mutates Docker and store: a.life inside
	// ── plan-7 ──
	case *mcsmv1.Envelope_BackupPush:
		// Disk and transfer with the life context: a WS drop does not abort it.
		a.handleBackupPush(life, env.Id, b.BackupPush, send)
	case *mcsmv1.Envelope_MigrateReceive:
		a.bk.handleMigrateReceive(env.Id, b.MigrateReceive, send)
	case *mcsmv1.Envelope_MigrateAbort:
		a.bk.handleMigrateAbort(env.Id, b.MigrateAbort, send)
	case *mcsmv1.Envelope_MigrateRetire:
		a.bk.handleMigrateRetire(env.Id, b.MigrateRetire, send)
	case *mcsmv1.Envelope_MigrateConfirm:
		a.bk.handleMigrateConfirm(env.Id, b.MigrateConfirm, send)
	// ── plan-8 ──
	case *mcsmv1.Envelope_RouterApply:
		a.handleRouterApply(env.Id, b.RouterApply, send)
	case *mcsmv1.Envelope_RouterRemove:
		a.handleRouterRemove(env.Id, send)
	// ── plan-9 ──
	case *mcsmv1.Envelope_RotateToken:
		a.handleRotateToken(env.Id, b.RotateToken, send)

	default:
		// Body nil: a newer panel sent a body this agent does not know (protobuf leaves it in
		// unknown fields). Otherwise, it is a known body that the panel does not send.
		msg := "unknown message: update the agent"
		if env.Body != nil {
			msg = fmt.Sprintf("message not supported by the agent: %T", env.Body)
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
			if a.streams[streamID] == me { // do not delete a stream that replaced it
				delete(a.streams, streamID)
			}
			a.mu.Unlock()
		}()
		tail := int(req.Tail)
		for ctx.Err() == nil {
			if cid := a.rec.ContainerID(ctx, req.ServerId); cid != "" {
				if sub, err := a.hub.SubscribeSub(req.ServerId, cid, tail); err == nil {
					tail = 0 // after reconnecting to the container we do not repeat the history
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

// pumpLogs forwards sub's lines until ctx ends or the follower closes, and every droppedEvery it notifies the
// panel of the lines dropped for being slow (StreamDropped, spec §5.2).
func (a *App) pumpLogs(ctx context.Context, streamID uint64, serverID string, sub *logs.Subscription, send func(*mcsmv1.Envelope) error) {
	tick := time.NewTicker(droppedEvery)
	defer tick.Stop()
	a.pump(ctx, streamID, serverID, sub.Lines, sub.Dropped, tick.C, send)
}

// pump is pumpLogs with its sources injectable (tests): the lines, the accumulated drop counter and the tick.
func (a *App) pump(ctx context.Context, streamID uint64, serverID string, lines <-chan logs.Line, dropped func() uint64, tick <-chan time.Time, send func(*mcsmv1.Envelope) error) {
	var reported uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick:
			if d := dropped(); d > reported {
				_ = send(&mcsmv1.Envelope{StreamId: streamID, Body: &mcsmv1.Envelope_StreamDropped{StreamDropped: &mcsmv1.StreamDropped{Count: d - reported}}})
				a.log.Warn("log lines dropped because of a slow subscriber", "server", serverID, "stream", streamID, "new", d-reported, "total", d)
				reported = d
			}
		case line, ok := <-lines:
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
					a.log.Warn("Docker event stream cut", "err", err)
				}
				break loop
			case ev, ok := <-events:
				if !ok {
					break loop
				}
				if isRouterEvent(ev.Labels) { // plan-8: the router's container
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
				// plan-9: crashes y OOM (spec §10).
				switch ev.Action {
				case "die":
					a.onDie(id, ev)
				case "oom":
					a.emitEvent(id, mcsmv1.EventLevel_EVENT_LEVEL_WARN, KindOOM,
						"Docker killed the server because it ran out of memory: raise the memory or the container limit in Configuration → Resources")
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

// observeAsync observes a server without blocking the caller: a server in a
// long operation (pull, 60 s stop) only holds back its own task.
func (a *App) observeAsync(ctx context.Context, id string) {
	a.dispatch(ctx, "obs:"+id, func() { a.rec.Observe(ctx, id) })
}

// reconcileAll runs a reconciliation pass without blocking the caller. It first
// retries the pending deletions of withdrawn servers (tombstones; bounded per pass
// and with backoff in the reconciler): a withdrawn slug recreated with another id reuses the
// container name. Then it reconciles each server separately and without waiting for
// any.
func (a *App) reconcileAll(ctx context.Context) {
	a.dispatch(ctx, "reconcile-all", func() {
		for _, id := range a.rec.RetryRemovals(ctx) {
			a.hub.Reset(id)
		}
		specs, err := a.st.ListSpecs()
		if err != nil {
			a.log.Error("list specs", "err", err)
			return
		}
		for _, sp := range specs {
			a.reconcileAsync(ctx, sp.ServerId, false)
		}
	})
}

// reconcileAsync reconciles a server with the per-server dispatcher. With force it
// skips the backoff (SyncSpecs); the mark is consumed on execution, so it survives
// coalescing with a tick that was already in progress.
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
			a.log.Warn("reconcile", "server", id, "err", err)
		}
	})
}

// dispatch runs fn in a goroutine with bounded concurrency. If a task with the
// same key is already in progress another is not stacked: a pending repeat is recorded.
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

// waitAll runs the shutdown waits at the same time (each with its own cap) and returns
// when all have finished: the total is the greatest of the caps, not the sum. false if
// any exceeded its deadline.
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
