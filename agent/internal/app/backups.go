package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
	"mcsm/agent/internal/spec"
)

const (
	// scheduleRefreshEvery: how often the scheduler is synchronized with the stored specs
	// (ApplySpec and SyncSpecs change them) and the servers blocked without data are reviewed.
	scheduleRefreshEvery = 15 * time.Second
	// rconCommandTimeout bounds each command of a hot backup (save-all flush on a large
	// world takes a while; mc.Rcon respects the context's deadline).
	rconCommandTimeout = 2 * time.Minute
	// resumeOnStartTimeout bounds the save-on sent at startup for an interrupted backup.
	resumeOnStartTimeout = 15 * time.Second
	// defaultReleaseWait is how long a job waits for the reconciliation done by releasing
	// the reservation before finishing and leaving it in the background.
	defaultReleaseWait = 3 * time.Minute
	// fileWritesDrainWait is how long a restore, with the server already reserved, waits for
	// the file writes that were in progress before setting data aside. Well below
	// the 30 s deadline with which the panel waits for the BackupRestore response.
	fileWritesDrainWait = 10 * time.Second
	// shutdownWait is the cap on the wait for backups in progress when the agent shuts down: the
	// save-on of a cancelled backup has its own 15 s deadline. The docker-compose files give the
	// agent stop_grace_period: 30s.
	shutdownWait = 25 * time.Second
	// outboxSize: at most this many notices to the panel pending delivery; those that do not fit are dropped.
	outboxSize = 256
	// maxInventoryBytes leaves margin under the panel WS's 4 MiB maxPayload: a larger message
	// would close the connection, and each reconnection would ask for the inventory again.
	maxInventoryBytes = 3 << 20
	// pruneReason is the reason of the pruning's BackupDeleted; deleteReason, that of the
	// deletions the panel requests.
	pruneReason  = "pruned"
	deleteReason = "deleted"
	// inventoryEvery: how often the agent sends the inventory unprompted (besides
	// after each Hello, when the panel asks for it). It restores notices dropped by the queue (a job
	// that would stay "running" in the panel) and a BackupList that failed and nobody retries.
	inventoryEvery = 10 * time.Minute
	// maxParallelJobs: backups and restores at once on the node (they compress, read and write
	// the whole disk; several backups at the same time would have N worlds in save-off at once).
	// The rest wait in the queue, with their server reserved and their world saving normally.
	maxParallelJobs = 2
)

var (
	errUnknownServer = errors.New("unknown server on this node")
	errBadRequest    = errors.New("invalid request")
	errBadSpec       = errors.New("the stored spec cannot be read")
	errClosing       = errors.New("the agent is shutting down")
	errOutboxFull    = errors.New("panel notice queue full")
)

// backupErrCode translates a failure of a backup request to the protocol's Error.code.
func backupErrCode(err error) string {
	switch {
	case errors.Is(err, reconcile.ErrBusy):
		return errcode.Busy
	case errors.Is(err, errUnknownServer):
		return errcode.UnknownServer
	case errors.Is(err, errBadRequest):
		return errcode.InvalidRequest
	case errors.Is(err, errBadSpec):
		return errcode.BadSpec
	case errors.Is(err, errExternalData): // plan-6
		return errcode.ExternalData
	default:
		return errcode.BackupFailed
	}
}

// backupService orchestrates backups and restores (spec §6.5): idempotent jobs by job_id
// (§5.4), reservation of the server in the reconciler (Hold) so an ApplySpec does not recreate the
// container midway, RCON, pruning, inventory for the panel, cron scheduling and
// recovery after a shutdown or crash midway through a job.
//
// Everything that mutates Docker or disk uses the agent's life context (App.life), not the
// WS session's: a job does not die with the connection. Notices to the panel (JobProgress,
// BackupCreated, BackupDeleted) go out through out, which never blocks whoever emits them.
type backupService struct {
	a       *App
	clock   backup.Clock
	sleep   func(ctx context.Context, d time.Duration) error
	jobs    *jobs.Tracker
	sched   *backup.Scheduler
	players *backup.PlayerWatch
	out     *outbox
	slots   chan struct{} // maxParallelJobs semaphore (see withSlot)

	// Injectable in tests.
	restore        func(ctx context.Context, req backup.RestoreRequest) (backup.Meta, error)
	recoverDisk    func(backupsDir, dataDir, slug string) (backup.Recovery, error)
	freeSpace      func(dir string) (uint64, error) // nil: statfs
	syncFS         func(dir string) error           // backup.RestoreRequest.SyncFS (nil: syncfs(2))
	releaseWait    time.Duration
	drainWait      time.Duration // ver fileWritesDrainWait
	inventoryLimit int

	// invMu orders the inventory with respect to the backup notices: it is computed and queued under
	// invMu, and BackupCreated/BackupDeleted are also queued under invMu, in the same FIFO
	// queue. This way the panel never receives before the inventory the notice of a change the
	// listing did not see (a new backup the inventory would consider deleted) nor, afterwards, an
	// inventory that still lists a backup already deleted and announced (which would resurrect it).
	invMu sync.Mutex

	mu      sync.Mutex
	closed  bool                             // wait started: no new tasks are launched
	blocked map[string]func(context.Context) // servers without data → their reservation (see block)

	saveOnMu sync.Mutex
	saveOn   map[string]*saveOnRetry // plan-9: save-on retries per server (retrySaveOn)

	wg sync.WaitGroup // backups, restores and releases in progress (tests wait with wg.Wait)
	// plan-7: MigrateAbort, MigrateRetire and MigrateConfirm of the same server, one at a time.
	migLocks keyedLocks
	loops    sync.WaitGroup // start loops
}

func newBackupService(a *App, clock backup.Clock) *backupService {
	b := &backupService{
		a: a, clock: clock, sleep: backup.Sleep,
		restore: backup.Restore, recoverDisk: backup.RecoverInterrupted,
		releaseWait: defaultReleaseWait, drainWait: fileWritesDrainWait, inventoryLimit: maxInventoryBytes,
		blocked: map[string]func(context.Context){},
		slots:   make(chan struct{}, maxParallelJobs),
		saveOn:  map[string]*saveOnRetry{},
	}
	// a.send is read on delivery: it is set before launching goroutines (Run or the test).
	b.out = newOutbox(func(e *mcsmv1.Envelope) error { return a.send(e) }, outboxSize, a.log, "backup and job notices")
	b.jobs = jobs.New(a.st, b.out.post, clock.Now)
	b.players = backup.NewPlayerWatch(clock.Now)
	b.sched = backup.NewScheduler(clock, b.onSchedule)
	return b
}

// spawn runs fn in the background, counted in wg, unless the agent is already shutting down
// (wait started): then it returns false and does not run it.
func (b *backupService) spawn(fn func()) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		fn()
	}()
	return true
}

// loop runs a background loop counted in loops.
func (b *backupService) loop(fn func()) {
	b.loops.Add(1)
	go func() {
		defer b.loops.Done()
		fn()
	}()
}

// recoverAtStart leaves the node coherent after a shutdown or crash midway through a job. It is called at
// startup, before the first reconciliation and before accepting jobs:
//
//  1. save-on to the running servers whose backup was left half done (save-off does not expire: the
//     world would stay without autosave), BEFORE marking the job: if the agent falls again
//     here, the next startup retries it.
//  2. FailInterrupted: RUNNING jobs become FAILED "interrupted" (and those finished more than
//     jobs.KeepFor ago are forgotten: it is the job pruning at startup).
//  3. Each server's disk (backup.RecoverInterrupted): leftovers out and, if data is missing
//     after a half-done swap, the original data back. If it cannot be returned,
//     the server stays blocked (block): not started and with the error in Observed.
func (b *backupService) recoverAtStart(ctx context.Context) {
	b.resumeInterrupted(ctx)
	if err := b.jobs.FailInterrupted(); err != nil {
		b.a.log.Warn("mark the interrupted jobs", "err", err)
	}
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		b.a.log.Error("list specs to recover backups and restores", "err", err)
		return
	}
	for _, sp := range specs {
		b.recoverServer(sp.ServerId)
	}
}

// resumeInterrupted sends save-on to the running servers with a RUNNING backup in the store.
func (b *backupService) resumeInterrupted(ctx context.Context) {
	recs, err := b.a.st.ListJobs()
	if err != nil {
		b.a.log.Warn("list jobs at startup", "err", err)
		return
	}
	var wg sync.WaitGroup
	seen := map[string]bool{}
	for _, r := range recs {
		if r.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING || r.Type != jobs.TypeBackup || seen[r.ServerId] {
			continue
		}
		seen[r.ServerId] = true
		wg.Add(1)
		go func(serverID string) {
			defer wg.Done()
			b.resumeSaves(ctx, serverID)
		}(r.ServerId)
	}
	wg.Wait()
}

func (b *backupService) resumeSaves(ctx context.Context, serverID string) {
	t, err := b.target(serverID)
	if err != nil {
		return // withdrawn or unreadable: nobody to send save-on to
	}
	running, err := b.isRunning(ctx, serverID)
	if err == nil && !running {
		return // stopped: on startup, the server saves by itself again
	}
	// Running, or unable to check (Docker does not respond): save-on is idempotent and against
	// a stopped server it fails immediately. Without it, FailInterrupted would forget the job.
	cctx, cancel := context.WithTimeout(ctx, resumeOnStartTimeout)
	defer cancel()
	if _, err := b.a.rcon(cctx, spec.ContainerName(t.slug), uint16(spec.RconPort), t.spec.RconPassword, "save-on"); err != nil {
		b.a.log.Error("an interrupted backup may have left autosave disabled and save-on failed: run save-on in the console", "server", t.slug, "err", err)
		b.markSaveOn(serverID) // plan-9 (m7): retrySaveOn retries it
		return
	}
	b.a.log.Warn("backup interrupted by the agent shutting down: autosave re-enabled (save-on)", "server", t.slug)
}

func (b *backupService) recoverServer(serverID string) {
	t, err := b.target(serverID)
	if err != nil {
		b.a.log.Warn("recover backups and restores", "server", serverID, "err", err)
		return
	}
	if t.spec.DataPath != "" { // plan-6 (m3): the agent does not see that folder and never backs up or restores there
		return
	}
	rec, err := b.recoverDisk(t.backupsDir, t.dataDir, t.slug)
	for _, p := range rec.Removed {
		b.a.log.Info("leftover of an interrupted backup or restore deleted", "server", t.slug, "path", p)
	}
	for _, w := range rec.Warnings {
		b.a.log.Warn("leftovers of an interrupted backup or restore", "server", t.slug, "warning", w)
	}
	if rec.RolledBack != "" {
		b.a.log.Warn("interrupted restore: the original data goes back to data", "server", t.slug, "from", rec.RolledBack)
	}
	if err == nil {
		return
	}
	release, herr := b.a.rec.Hold(serverID, "no data directory")
	if herr != nil {
		b.a.log.Error("could not block a server without data", "server", t.slug, "err", herr)
		return
	}
	b.block(serverID, release, dataMissingMsg(t.dataDir, err))
}

func dataMissingMsg(dataDir string, err error) string {
	return fmt.Sprintf("%v. The server will not be started until %s exists: put the data back there (or create the empty folder to start a new world)", err, dataDir)
}

// block leaves a server reserved (release is its reservation), stopped and with msg in Observed
// until its data directory exists again (checkBlocked). Without data, releasing it would
// start it: Docker would create an empty data and the server would generate a new world.
func (b *backupService) block(serverID string, release func(context.Context), msg string) {
	b.a.rec.HoldError(serverID, msg)
	// plan-8: mc-router would start an on-demand server even if it is reserved, and Docker would create
	// an empty data for it: it is parked (without a container) until the data returns.
	if _, err := b.a.rec.Park(b.a.life, serverID); err != nil {
		b.a.log.Error("could not park a server without data", "server", serverID, "err", err)
	}
	b.mu.Lock()
	b.blocked[serverID] = release
	b.mu.Unlock()
	b.a.log.Error("server without a data directory: it will not be started", "server", serverID, "reason", msg)
	b.a.observeAsync(b.a.life, serverID) // the error, to the panel as soon as possible
}

// checkBlocked retries recovering the data of the blocked servers and releases those that
// have it again (returned by hand, or an empty folder to start from scratch) and those
// the panel withdrew (the release completes the deletion of their container).
func (b *backupService) checkBlocked() {
	b.mu.Lock()
	ids := make([]string, 0, len(b.blocked))
	for id := range b.blocked {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	sort.Strings(ids)
	for _, id := range ids {
		if b.dataBack(id) {
			b.unblock(id)
		}
	}
}

func (b *backupService) dataBack(serverID string) bool {
	t, err := b.target(serverID)
	if errors.Is(err, errUnknownServer) {
		return true
	}
	if err != nil {
		return false
	}
	if _, err := b.recoverDisk(t.backupsDir, t.dataDir, t.slug); err != nil {
		return false
	}
	fi, err := os.Lstat(t.dataDir)
	return err == nil && fi.IsDir()
}

func (b *backupService) unblock(serverID string) {
	b.mu.Lock()
	release, ok := b.blocked[serverID]
	delete(b.blocked, serverID)
	b.mu.Unlock()
	if !ok {
		return
	}
	b.a.log.Info("server unblocked: it has a data directory again or was withdrawn", "server", serverID)
	b.spawn(func() { release(b.a.life) })
}

// start starts the queue of notices to the panel, the scheduler and its 15 s refresh (which
// also reviews the blocked servers) and the periodic inventory. recoverAtStart goes first.
func (b *backupService) start(ctx context.Context) {
	b.refreshSchedules()
	b.loop(func() { b.out.run(ctx) })
	b.loop(func() { b.sched.Run(ctx) })
	b.loop(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-b.clock.Until(b.clock.Now().Add(scheduleRefreshEvery)):
				b.refreshSchedules()
				b.checkBlocked()
				b.retrySaveOn(ctx) // plan-9 (m6/m7)
			}
		}
	})
	b.loop(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-b.clock.Until(b.clock.Now().Add(inventoryEvery)):
				b.periodicInventory()
			}
		}
	})
}

// wait waits, for at most d, for the backups, restores and releases in progress and for the
// start loops. It is called when the agent shuts down, with its life context already cancelled: a
// hot backup aborts and its defer sends save-on (with its own deadline). From here no
// new tasks are launched. It returns false if the cap expired.
func (b *backupService) wait(d time.Duration) bool {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		b.loops.Wait()
		close(done)
	}()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		b.a.log.Warn("shutting down without waiting for the backups in progress: the deadline expired", "deadline", d)
		return false
	}
}

// refreshSchedules synchronizes the scheduler with the stored specs.
func (b *backupService) refreshSchedules() {
	specs, err := b.a.st.ListSpecs()
	if err != nil {
		b.a.log.Warn("read specs to schedule backups", "err", err)
		return
	}
	want := map[string]string{}
	for _, sp := range specs {
		parsed, err := spec.Parse(sp.SpecJson)
		if err != nil || parsed.Backups == nil || !parsed.Backups.Enabled {
			continue
		}
		want[sp.ServerId] = parsed.Backups.Cron
	}
	for _, id := range b.sched.IDs() {
		if _, ok := want[id]; !ok {
			b.sched.Remove(id)
		}
	}
	for id, expr := range want {
		if err := b.sched.Set(id, expr); err != nil {
			b.a.log.Warn("invalid backup cron", "server", id, "err", err)
		}
	}
}

// target is a node server with what its backups need.
//
// The spec's backups section is used as is: the panel stores and sends the spec already parsed
// by zod, with all the default values set, and the agent does not repeat them (two sources
// of truth that could diverge). A partial section (hand-written spec or old panel)
// keeps Go's zeros, which fail toward saving more: no exclusions, no pruning and no
// skipping backups for lack of players. Without a section, manual backups use
// spec.DefaultBackupExcludes and there is no schedule.
type target struct {
	serverID   string
	slug       string
	version    uint64
	spec       spec.Spec
	dataDir    string
	backupsDir string
}

// target resolves a server from the store. The agent only operates on its own node's servers
// (spec §9): one that is not in the store is errUnknownServer.
func (b *backupService) target(serverID string) (*target, error) {
	sp, err := b.a.st.GetSpec(serverID)
	if err != nil {
		return nil, err
	}
	if sp == nil {
		return nil, errUnknownServer
	}
	parsed, err := spec.Parse(sp.SpecJson)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadSpec, err)
	}
	build, err := spec.BuildContainer(spec.Meta{ServerID: sp.ServerId, Slug: sp.Slug, Version: sp.Version}, parsed, b.a.cfg.DataRoot, b.a.cfg.Network)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadSpec, err)
	}
	return &target{
		serverID: sp.ServerId, slug: sp.Slug, version: sp.Version, spec: parsed,
		dataDir: build.DataDir, backupsDir: backup.Dir(b.a.cfg.DataRoot, sp.Slug),
	}, nil
}

func (b *backupService) handleBackupNow(id uint64, m *mcsmv1.BackupNow, send func(*mcsmv1.Envelope) error) {
	trigger := backup.TriggerFromProto(m.GetTrigger())
	if trigger != backup.TriggerManual && trigger != backup.TriggerPreMigration {
		_ = send(errMsg(id, errcode.InvalidRequest, fmt.Errorf("backup type not allowed from the panel: %s", trigger)))
		return
	}
	if err := b.startBackup(m.GetJobId(), m.GetServerId(), trigger); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

func (b *backupService) handleBackupRestore(id uint64, m *mcsmv1.BackupRestore, send func(*mcsmv1.Envelope) error) {
	if err := b.startRestore(m.GetJobId(), m.GetServerId(), m.GetFilename()); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

func (b *backupService) handleBackupDelete(id uint64, m *mcsmv1.BackupDelete, send func(*mcsmv1.Envelope) error) {
	if err := b.deleteBackup(m.GetServerId(), m.GetFilename()); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// handleBackupList queues the inventory as an unsolicited message (id 0) and answers Ack. It goes
// through the notice queue (see invMu), so it may arrive before or after the Ack, and even
// in the next session: it carries the request's id in request_id so the panel
// can correlate it.
func (b *backupService) handleBackupList(id uint64, m *mcsmv1.BackupList, send func(*mcsmv1.Envelope) error) {
	if err := b.postInventory(m.GetServerId(), id); err != nil {
		_ = send(errMsg(id, backupErrCode(err), err))
		return
	}
	_ = send(ack(id))
}

// postInventory computes the inventory and queues it, all under invMu. requestID is the id of the
// BackupList it answers (0: periodic).
func (b *backupService) postInventory(serverID string, requestID uint64) error {
	b.invMu.Lock()
	defer b.invMu.Unlock()
	inv, err := b.inventory(serverID)
	if err != nil {
		return err
	}
	inv.RequestId = requestID
	return b.out.post(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupInventory{BackupInventory: inv}})
}

// periodicInventory sends the whole node's inventory unprompted (every inventoryEvery).
// With request_id 0 the panel only applies the positive (new backups and job states).
func (b *backupService) periodicInventory() {
	if err := b.postInventory("", 0); err != nil {
		b.a.log.Warn("periodic backup inventory", "err", err)
	}
}

// postChange queues a backup notice (BackupCreated, BackupDeleted) under invMu.
func (b *backupService) postChange(e *mcsmv1.Envelope) {
	b.invMu.Lock()
	defer b.invMu.Unlock()
	_ = b.out.post(e)
}

// startBackup registers the job, reserves the server and launches the backup in the background. With
// an already known job_id it repeats nothing: it resends the stored state (spec §5.4).
func (b *backupService) startBackup(jobID, serverID, trigger string) error {
	if jobID == "" {
		return fmt.Errorf("%w: job_id is missing", errBadRequest)
	}
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
	j, existing, err := b.jobs.Begin(jobID, serverID, jobs.TypeBackup)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	release, err := b.a.rec.Hold(serverID, holdBackup)
	if err != nil {
		b.finish(j, err, "")
		return err
	}
	if trigger == backup.TriggerPreMigration {
		// plan-7: the backup being migrated is made cold and without half-done writes (like a
		// restore): a start or an upload arriving after step 1 would leave it out of
		// sync with whatever the source keeps writing.
		if err := b.preMigrationReady(serverID, j); err != nil {
			// Inline, as when the launch fails: the server is stopped or unchanged (the
			// reconciliation is immediate) and the panel starts it again as soon as it receives the error.
			release(b.a.life)
			b.finish(j, err, "")
			return err
		}
	}
	return b.launchBackup(j, serverID, trigger, release)
}

// holdBackup is the reason for a backup's reservation.
const holdBackup = "backup"

// launchBackup launches in the background the backup of an already registered job with the server
// reserved. If the agent is shutting down, it releases and closes the job.
func (b *backupService) launchBackup(j *jobs.Job, serverID, trigger string, release func(context.Context)) error {
	if !b.spawn(func() { b.runBackupJob(serverID, trigger, j, release) }) {
		release(b.a.life)
		b.finish(j, errClosing, "")
		return errClosing
	}
	return nil
}

func (b *backupService) runBackupJob(serverID, trigger string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	var meta backup.Meta
	err := b.withSlot(ctx, j, func() (err error) {
		meta, err = b.runBackup(ctx, serverID, trigger, j)
		return err
	})
	err = interrupted(ctx, err)
	b.releaseHold(j, serverID, release)
	b.finish(j, err, "Backup created: "+meta.Filename)
}

// withSlot runs fn with one of the node's maxParallelJobs slots. It is taken before
// save-off (backup) or before stopping the server (restore); if there is none, the job says so and waits
// in the queue without failing. It only fails if the agent shuts down while waiting.
func (b *backupService) withSlot(ctx context.Context, j *jobs.Job, fn func() error) error {
	select {
	case b.slots <- struct{}{}:
	default:
		j.Progress(0, "Queued: waiting for other backups or restores on the node to finish")
		select {
		case b.slots <- struct{}{}:
		case <-ctx.Done():
			return fmt.Errorf("en cola: %w", ctx.Err())
		}
	}
	defer func() { <-b.slots }()
	return fn()
}

// interrupted explains a failure caused by the agent shutting down (life context cancelled).
func interrupted(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil {
		return fmt.Errorf("interrupted: the agent is shutting down (%w)", err)
	}
	return err
}

// finish closes the job and records if its final state could not be saved.
func (b *backupService) finish(j *jobs.Job, err error, okMsg string) {
	if perr := j.Done(err, okMsg); perr != nil {
		b.a.log.Error("save the job's final state", "job", j.ID(), "err", perr)
	}
}

// releaseHold releases the reservation, which reconciles the server: it applies the spec that arrived
// during the job and returns it to its desired state. It goes with the agent's life context and without
// a deadline of its own: if the deferred spec changes the image, a deadline could cut the pull with the
// old container already deleted and leave the server down until the next tick with backoff.
// If it takes longer than releaseWait, the job stops waiting for it and finishes; the reconciliation continues in the
// background (counted in wg). When the agent shuts down it is cancelled, and the server is reconciled
// on the next startup.
func (b *backupService) releaseHold(j *jobs.Job, serverID string, release func(context.Context)) {
	if sp, err := b.a.st.GetSpec(serverID); err == nil && sp != nil {
		if applied, _ := b.a.st.Applied(serverID); applied != sp.Version {
			j.Log(fmt.Sprintf("applying the configuration that arrived during the job (version %d)", sp.Version))
		}
	}
	done := make(chan struct{})
	b.wg.Add(1) // the caller is a job counted in wg: the counter is not at zero
	go func() {
		defer b.wg.Done()
		defer close(done)
		release(b.a.life)
	}()
	select {
	case <-done:
	case <-b.clock.Until(b.clock.Now().Add(b.releaseWait)):
		j.Log("the pending configuration keeps being applied in the background (e.g. downloading a new image)")
	}
}

func (b *backupService) runBackup(ctx context.Context, serverID, trigger string, j *jobs.Job) (backup.Meta, error) {
	t, err := b.target(serverID)
	if err != nil {
		return backup.Meta{}, err
	}
	req := backup.CreateRequest{
		ServerID: serverID, Slug: t.slug, SpecVersion: t.version, Trigger: trigger,
		DataDir: t.dataDir, BackupsDir: t.backupsDir, Excludes: t.spec.BackupExcludes(),
		Now: b.clock.Now, Sleep: b.sleep, Progress: j.Progress, Log: j.Log, FreeSpace: b.freeSpace,
	}
	live, err := b.runningContainer(ctx, serverID)
	if err != nil {
		return backup.Meta{}, err
	}
	if live != nil {
		j.Log("server running: hot backup with save-off / save-all flush / save-on")
		host, pass := spec.ContainerName(t.slug), t.spec.RconPassword
		req.Rcon = func(ctx context.Context, cmd string) (string, error) {
			cctx, cancel := context.WithTimeout(ctx, rconCommandTimeout)
			defer cancel()
			return b.a.rcon(cctx, host, uint16(spec.RconPort), pass, cmd)
		}
		req.Running = func(ctx context.Context) error { return b.stillRunning(ctx, serverID, live) }
	} else {
		j.Log("server stopped: direct backup")
		// plan-8: without a container, mc-router cannot wake it midway through a cold backup.
		if parked, err := b.a.rec.Park(ctx, serverID); err != nil {
			return backup.Meta{}, err
		} else if parked {
			j.Log("on-demand server parked: its container is recreated when finished")
		}
	}
	meta, err := backup.Create(ctx, req)
	if err != nil { // a failed backup does not stay on disk: it is neither announced nor pruned
		if errors.Is(err, backup.ErrResume) { // plan-9 (m6): the world may have been left in save-off
			b.markSaveOn(serverID)
		}
		return backup.Meta{}, err
	}
	b.announce(meta, serverID, j.ID())
	b.prune(t)
	return meta, nil
}

// isRunning says whether the server's container is running. If Docker does not allow checking it,
// it returns an error, never "stopped": a backup would take it for cold (without save-off) and a
// restore would swap data with the server writing.
func (b *backupService) isRunning(ctx context.Context, serverID string) (bool, error) {
	ins, err := b.runningContainer(ctx, serverID)
	return ins != nil, err
}

// runningContainer returns the inspection of the server's container if it is running, or nil
// if it does not exist or is stopped. Same errors as isRunning.
func (b *backupService) runningContainer(ctx context.Context, serverID string) (*docker.Inspect, error) {
	c, err := b.a.rec.Container(ctx, serverID)
	if err != nil {
		return nil, errCheckContainer(err)
	}
	if c == nil {
		return nil, nil
	}
	ins, err := b.a.eng.Inspect(ctx, c.ID)
	if errors.Is(err, docker.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, errCheckContainer(err)
	}
	if !ins.Running {
		return nil, nil
	}
	return ins, nil
}

// stillRunning checks during a hot backup that the server's container is the same
// as at the start (id) and that it has not stopped or restarted since (StartedAt):
// mc-router stops it for inactivity without looking at the reservation, and Minecraft saves when stopping even with
// save-off. A stop wraps backup.ErrServerStopped; a Docker failure does not.
func (b *backupService) stillRunning(ctx context.Context, serverID string, was *docker.Inspect) error {
	c, err := b.a.rec.Container(ctx, serverID)
	if err != nil {
		return fmt.Errorf("Docker: %w", err)
	}
	if c == nil || c.ID != was.ID {
		return fmt.Errorf("%w (its container is no longer the same)", backup.ErrServerStopped)
	}
	ins, err := b.a.eng.Inspect(ctx, c.ID)
	switch {
	case errors.Is(err, docker.ErrNotFound):
		return fmt.Errorf("%w (its container no longer exists)", backup.ErrServerStopped)
	case err != nil:
		return fmt.Errorf("Docker: %w", err)
	case !ins.Running:
		return fmt.Errorf("%w (its container is no longer running)", backup.ErrServerStopped)
	case !ins.StartedAt.Equal(was.StartedAt):
		return fmt.Errorf("%w (its container restarted)", backup.ErrServerStopped)
	}
	return nil
}

func errCheckContainer(err error) error {
	return fmt.Errorf("could not check whether the server is running (Docker: %w); nothing is done", err)
}

// announce notifies the panel of a new backup (also of the pre-restore data).
func (b *backupService) announce(m backup.Meta, serverID, jobID string) {
	b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupCreated{BackupCreated: &mcsmv1.BackupCreated{Backup: m.Info(serverID), JobId: jobID}}})
}

// prune applies keepDays/keepCount to the scheduled backups after each backup (spec §6.5).
func (b *backupService) prune(t *target) {
	cfg := t.spec.Backups
	if cfg == nil {
		return
	}
	metas, err := backup.List(t.backupsDir, t.slug)
	if err != nil {
		b.a.log.Warn("list backups to prune", "server", t.slug, "err", err)
		return
	}
	for _, name := range backup.PrunePlan(metas, cfg.KeepDays, cfg.KeepCount, b.clock.Now()) {
		if err := backup.Delete(t.backupsDir, t.dataDir, t.slug, name); err != nil {
			b.a.log.Warn("prune backup", "server", t.slug, "file", name, "err", err)
			continue
		}
		b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupDeleted{BackupDeleted: &mcsmv1.BackupDeleted{
			ServerId: t.serverID, Filename: name, Reason: pruneReason,
		}}})
	}
}

// startRestore validates, registers the job, reserves the server and restores in the background.
func (b *backupService) startRestore(jobID, serverID, filename string) error {
	if jobID == "" {
		return fmt.Errorf("%w: job_id is missing", errBadRequest)
	}
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if err := externalDataSpec(t.spec); err != nil { // plan-6
		return err
	}
	if !backup.ValidName(t.slug, filename) {
		return fmt.Errorf("%w: invalid backup name %q", errBadRequest, filename)
	}
	j, existing, err := b.jobs.Begin(jobID, serverID, jobs.TypeRestore)
	if err != nil {
		return err
	}
	if existing != nil {
		b.jobs.Replay(existing)
		return nil
	}
	release, err := b.a.rec.Hold(serverID, "restore")
	if err != nil {
		b.finish(j, err, "")
		return err
	}
	if err := b.drainFileWrites(serverID, j); err != nil {
		// The response does not wait for the release: it reconciles and would apply (pull included) a
		// spec that arrived during the wait, beyond the deadline with which the panel waits for this
		// response.
		b.releaseAsync(release)
		b.finish(j, err, "")
		return err
	}
	if !b.spawn(func() { b.runRestoreJob(t, filename, j, release) }) {
		release(b.a.life)
		b.finish(j, errClosing, "")
		return errClosing
	}
	return nil
}

// releaseAsync releases a reservation in the background with the agent's life context,
// counted in wg (the shutdown wait includes it). If the agent is already shutting down, it releases inline:
// with the context cancelled the reconciliation does not wait, and the next startup completes it.
func (b *backupService) releaseAsync(release func(context.Context)) {
	if !b.spawn(func() { release(b.a.life) }) {
		release(b.a.life)
	}
}

// drainFileWrites waits, for at most drainWait, for the file writes that were already in progress
// on serverID when reserving it to finish (new ones already answer busy). If they do not
// finish, the restore does not start: ErrBusy. See fileWrites.
func (b *backupService) drainFileWrites(serverID string, j *jobs.Job) error {
	drained := b.a.fileWrites.drained(serverID)
	select {
	case <-drained:
		return nil
	default:
	}
	j.Progress(0, "Waiting for the file operations in progress to finish")
	select {
	case <-drained:
		return nil
	case <-b.clock.Until(b.clock.Now().Add(b.drainWait)):
		return fmt.Errorf("%w: there are file operations in progress on the server (uploads, writes or deletions); wait for them to finish and try again", reconcile.ErrBusy)
	case <-b.a.life.Done():
		return errClosing
	}
}

func (b *backupService) runRestoreJob(t *target, filename string, j *jobs.Job, release func(context.Context)) {
	ctx := b.a.life
	err := b.withSlot(ctx, j, func() error { return b.runRestore(ctx, t.serverID, filename, j) })
	if errors.Is(err, backup.ErrDataMissing) {
		// Not released: releasing would reconcile and start the server over an empty data.
		b.block(t.serverID, release, dataMissingMsg(t.dataDir, err))
		b.finish(j, err, "")
		return
	}
	err = interrupted(ctx, err)
	if err == nil {
		j.Progress(95, "Starting the server again if it was running")
	}
	b.releaseHold(j, t.serverID, release) // reconciles: it starts it if its desired state is running
	b.finish(j, err, "Restore completed from "+filename)
}

func (b *backupService) runRestore(ctx context.Context, serverID, filename string, j *jobs.Job) error {
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	c, err := b.a.rec.Container(ctx, serverID)
	if err != nil {
		return errCheckContainer(err)
	}
	if c != nil {
		j.Progress(1, "Stopping the server")
		// plan-8: an on-demand server is parked (its container is deleted) so mc-router does not
		// start it over the old world if someone tries to join during the restore.
		parked, err := b.a.rec.Park(ctx, serverID)
		if err != nil {
			return fmt.Errorf("stop the server: %w", err)
		}
		if parked {
			j.Log("on-demand server parked: its container is recreated when finished")
		} else if err := b.a.eng.Stop(ctx, c.ID, reconcile.StopTimeout); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("stop the server: %w", err)
		}
		running, err := b.isRunning(ctx, serverID)
		if err != nil {
			return err
		}
		if running {
			return errors.New("the server is still running: it is not restored")
		}
		j.Log("server stopped")
	}
	pre, err := b.restore(ctx, backup.RestoreRequest{
		ServerID: serverID, Slug: t.slug, Filename: filename, DataDir: t.dataDir, BackupsDir: t.backupsDir,
		Now: b.clock.Now, Progress: j.Progress, Log: j.Log, SyncFS: b.syncFS,
	})
	if err != nil {
		return err
	}
	if pre.Filename != "" {
		b.announce(pre, serverID, "") // the previous data is registered as a pre_restore backup
	}
	return nil
}

// deleteBackup deletes a backup or a pre-restore directory. With the server reserved (backup,
// restore or without data) it answers busy: a pre-restore may be the only thing left.
func (b *backupService) deleteBackup(serverID, filename string) error {
	t, err := b.target(serverID)
	if err != nil {
		return err
	}
	if !backup.ValidName(t.slug, filename) && !backup.ValidPreRestoreName(t.dataDir, filename) {
		return fmt.Errorf("%w: invalid backup name %q", errBadRequest, filename)
	}
	if reason := b.a.rec.HeldReason(serverID); reason != "" {
		return fmt.Errorf("%w: backups cannot be deleted while the reservation lasts", reconcile.Busy(reason))
	}
	if err := backup.Delete(t.backupsDir, t.dataDir, t.slug, filename); err != nil {
		return err
	}
	// Through the queue, behind an inventory that still listed it (the Ack may get ahead of it).
	b.postChange(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_BackupDeleted{BackupDeleted: &mcsmv1.BackupDeleted{
		ServerId: serverID, Filename: filename, Reason: deleteReason,
	}}})
	return nil
}

// inventory lists backups (and pre-restore data) and recent jobs; empty serverID = the whole
// node. A server whose listing fails, or that does not fit in inventoryLimit, is omitted entirely
// (out of server_ids): the panel marks nothing of its as deleted.
func (b *backupService) inventory(serverID string) (*mcsmv1.BackupInventory, error) {
	var specs []*mcsmv1.ServerSpec
	if serverID != "" {
		sp, err := b.a.st.GetSpec(serverID)
		if err != nil {
			return nil, err
		}
		if sp == nil {
			return nil, errUnknownServer
		}
		specs = []*mcsmv1.ServerSpec{sp}
	} else {
		var err error
		if specs, err = b.a.st.ListSpecs(); err != nil {
			return nil, err
		}
	}
	recs, err := b.jobs.Inventory(serverID)
	if err != nil {
		return nil, err
	}
	inv := &mcsmv1.BackupInventory{Jobs: recs}
	size := proto.Size(inv)
	for _, sp := range specs {
		infos, err := b.listing(sp.ServerId)
		if err != nil {
			b.a.log.Warn("backup inventory", "server", sp.Slug, "err", err)
			continue
		}
		n := len(sp.ServerId) + 8 // tag and length of each repeated element: generous
		for _, info := range infos {
			n += proto.Size(info) + 8
		}
		if size+n > b.inventoryLimit {
			b.a.log.Warn("backup inventory too large: this server is omitted (delete old backups)", "server", sp.Slug, "backups", len(infos))
			continue
		}
		size += n
		inv.ServerIds = append(inv.ServerIds, sp.ServerId)
		inv.Backups = append(inv.Backups, infos...)
	}
	return inv, nil
}

func (b *backupService) listing(serverID string) ([]*mcsmv1.BackupInfo, error) {
	t, err := b.target(serverID)
	if err != nil {
		return nil, err
	}
	archives, err := backup.List(t.backupsDir, t.slug)
	if err != nil {
		return nil, err
	}
	var pre []backup.Meta
	if t.spec.DataPath == "" { // plan-6 (m3): with dataPath there are no restores and the agent does not see the folder
		if pre, err = backup.ListPreRestore(t.dataDir); err != nil {
			return nil, err
		}
	}
	out := make([]*mcsmv1.BackupInfo, 0, len(archives)+len(pre))
	for _, m := range append(archives, pre...) {
		out = append(out, m.Info(serverID))
	}
	return out, nil
}

// onSchedule is called by the scheduler from its loop: it returns right away (the backup runs in its
// own goroutine) so as not to delay other servers' firings, which maxLate would skip.
func (b *backupService) onSchedule(serverID string) {
	b.spawn(func() { b.scheduled(serverID) })
}

// scheduled runs a firing. It checks again that the server is still on the node and the
// schedule active: between the firing and here a Remove or a new spec may have arrived that the
// scheduler's refresh has not picked up yet. A server without data (never started yet) or
// already reserved (another backup in progress, a cron faster than the backup, or blocked without data)
// is skipped with a log warning, without a job: a FAILED job on every firing would only be noise.
// That is why here the reservation goes before the job.
func (b *backupService) scheduled(serverID string) {
	t, err := b.target(serverID)
	if errors.Is(err, errUnknownServer) {
		return
	}
	if err != nil {
		b.a.log.Warn("scheduled backup", "server", serverID, "err", err)
		return
	}
	cfg := t.spec.Backups
	if cfg == nil || !cfg.Enabled {
		return
	}
	if fi, err := os.Lstat(t.dataDir); err != nil || !fi.IsDir() {
		b.a.log.Warn("scheduled backup skipped: the server does not have a data directory yet", "server", t.slug)
		return
	}
	if !backup.ShouldRun(cfg.OnlyIfPlayersSince, b.lastBackup(t), b.players.LastSeen(serverID), b.players.Since()) {
		b.a.log.Info("scheduled backup skipped: nobody has connected since the last one", "server", t.slug)
		return
	}
	release, err := b.a.rec.Hold(serverID, holdBackup)
	if err != nil {
		b.a.log.Warn("scheduled backup skipped", "server", t.slug, "err", err)
		return
	}
	j, _, err := b.jobs.Begin(jobs.NewID(), serverID, jobs.TypeBackup)
	if err != nil {
		release(b.a.life)
		b.a.log.Warn("scheduled backup", "server", t.slug, "err", err)
		return
	}
	if err := b.launchBackup(j, serverID, backup.TriggerScheduled, release); err != nil {
		b.a.log.Warn("scheduled backup", "server", t.slug, "err", err)
	}
}

// lastBackup is the START of the most recent backup (ShouldRun demands it: with the end, a
// player who joined during the backup would count as earlier than it).
func (b *backupService) lastBackup(t *target) time.Time {
	metas, err := backup.List(t.backupsDir, t.slug)
	if err != nil || len(metas) == 0 {
		return time.Time{}
	}
	return metas[0].StartedAt
}

// markSaveOn records that serverID's autosave may have been left disabled (save-on failed at the end of a
// backup or when the agent started) and notifies the panel. retrySaveOn retries it (m6/m7 of Plan 4).
func (b *backupService) markSaveOn(serverID string) {
	if err := b.a.st.MarkSaveOnPending(serverID, b.clock.Now()); err != nil {
		b.a.log.Error("record pending save-on", "server", serverID, "err", err)
	}
	b.a.emitEvent(serverID, mcsmv1.EventLevel_EVENT_LEVEL_WARN, KindSaveOnPending,
		"Autosave may have been left disabled (save-on failed). The agent retries (every 30 s to 5 min); if you can, run save-on in the console")
}

// save-on retries (plan-9, m6/m7 of Plan 4).
const (
	// saveOnRetryTimeout bounds the retry's Docker check and RCON: the server is reserved meanwhile.
	saveOnRetryTimeout = 5 * time.Second
	// saveOnBackoffMin and saveOnBackoffMax: wait after each failure of a server (it doubles up to the cap). A
	// success, or the server stopped or withdrawn, resets it.
	saveOnBackoffMin = 30 * time.Second
	saveOnBackoffMax = 5 * time.Minute
)

// saveOnRetry is the in-memory state of a server's retries.
type saveOnRetry struct {
	fails   int
	next    time.Time // not before this
	running bool      // a retry is in progress
}

// saveOnOutcome is the result of a retry.
type saveOnOutcome int

const (
	saveOnSkipped saveOnOutcome = iota // reserved or busy: the next pass, without penalty
	saveOnFailed                       // Docker or RCON failed: growing wait
	saveOnDone                         // re-enabled, or no longer needed (stopped, withdrawn)
)

// retrySaveOn launches, each in its own goroutine, the save-on retries of the pending servers that are due
// (see saveOnBackoffMin). It waits for none nor launches two for the same server at once.
func (b *backupService) retrySaveOn(ctx context.Context) {
	ids, err := b.a.st.SaveOnPending()
	if err != nil {
		b.a.log.Warn("list pending save-on", "err", err)
		return
	}
	now := b.clock.Now()
	for _, id := range ids {
		b.saveOnMu.Lock()
		st := b.saveOn[id]
		if st == nil {
			st = &saveOnRetry{}
			b.saveOn[id] = st
		}
		if st.running || now.Before(st.next) {
			b.saveOnMu.Unlock()
			continue
		}
		st.running = true
		b.saveOnMu.Unlock()
		if !b.spawn(func() { b.finishSaveOn(id, b.retryOneSaveOn(ctx, id)) }) {
			b.finishSaveOn(id, saveOnSkipped)
		}
	}
}

// finishSaveOn records the result of a retry: success forgets the state and failure lengthens the wait.
func (b *backupService) finishSaveOn(id string, out saveOnOutcome) {
	b.saveOnMu.Lock()
	defer b.saveOnMu.Unlock()
	st := b.saveOn[id]
	if st == nil {
		return
	}
	st.running = false
	switch out {
	case saveOnDone:
		delete(b.saveOn, id)
	case saveOnFailed:
		wait := saveOnBackoffMin
		for i := 0; i < st.fails && wait < saveOnBackoffMax; i++ {
			wait *= 2
		}
		st.next = b.clock.Now().Add(min(wait, saveOnBackoffMax))
		st.fails++
	}
}

// holdSaveOn is the reason for the short reservation with which retrySaveOn sends save-on.
const holdSaveOn = "re-enabling autosave"

// retryOneSaveOn retries id's save-on with the server reserved while it checks Docker and sends the RCON (both
// things, at most saveOnRetryTimeout; the reservation's release reconciles afterwards, outside that deadline): a
// hot backup that started between the check and the RCON would do save-off and this
// save-on would re-enable saving midway through the tar. With the reservation, that backup gets busy. TryHold does not wait: if the
// server is reserved or busy, it is skipped. It does not use withSlot: it is not a job nor does it write to disk.
func (b *backupService) retryOneSaveOn(ctx context.Context, id string) saveOnOutcome {
	t, err := b.target(id)
	if errors.Is(err, errUnknownServer) {
		_ = b.a.st.ClearSaveOnPending(id)
		return saveOnDone
	}
	if err != nil {
		return saveOnFailed
	}
	release, err := b.a.rec.TryHold(id, holdSaveOn)
	if err != nil {
		return saveOnSkipped
	}
	defer release(ctx)
	// Everything done with the server reserved (the Docker check and the RCON) fits in saveOnRetryTimeout.
	cctx, cancel := context.WithTimeout(ctx, saveOnRetryTimeout)
	defer cancel()
	running, err := b.isRunning(cctx, id)
	if err != nil {
		return saveOnFailed
	}
	if !running {
		_ = b.a.st.ClearSaveOnPending(id)
		b.a.log.Info("pending save-on forgotten: the server is stopped and will save on startup", "server", t.slug)
		return saveOnDone
	}
	_, err = b.a.rcon(cctx, spec.ContainerName(t.slug), uint16(spec.RconPort), t.spec.RconPassword, "save-on")
	if err != nil {
		b.a.log.Warn("save-on retry failed", "server", t.slug, "err", err)
		return saveOnFailed
	}
	if err := b.a.st.ClearSaveOnPending(id); err != nil {
		b.a.log.Warn("delete pending save-on", "server", t.slug, "err", err)
	}
	b.a.log.Info("autosave re-enabled (save-on)", "server", t.slug)
	b.a.emitEvent(id, mcsmv1.EventLevel_EVENT_LEVEL_INFO, KindSaveOnResumed, "Autosave re-enabled (save-on)")
	return saveOnDone
}

// outbox delivers to the panel, in order and without blocking whoever emits them, the backup and
// job notices. A job emits from the backup (with the world in save-off) and Tracker.Begin does so
// with its mutex held: a slow send —with the WS session half dead each write waits up to
// 10 s— must not hold them back. With the queue full the notice is dropped: the inventory the panel
// asks for after each Hello restores the state. plan-9: Events go through another outbox (App.events).
type outbox struct {
	deliver func(*mcsmv1.Envelope) error
	ch      chan outItem
	log     *slog.Logger
	what    string // what the queue carries, for the drop warning (e.g. "backup and job notices")
	dropped atomic.Uint64
}

// outItem is a notice or, with mark, a mark that is closed on reaching it (tests).
type outItem struct {
	env  *mcsmv1.Envelope
	mark chan struct{}
}

func newOutbox(deliver func(*mcsmv1.Envelope) error, size int, log *slog.Logger, what string) *outbox {
	return &outbox{deliver: deliver, ch: make(chan outItem, size), log: log, what: what}
}

// post queues a notice without blocking.
func (o *outbox) post(e *mcsmv1.Envelope) error {
	select {
	case o.ch <- outItem{env: e}:
		return nil
	default:
		o.dropped.Add(1)
		return errOutboxFull
	}
}

// run delivers the notices until ctx ends.
func (o *outbox) run(ctx context.Context) {
	var reported uint64
	for {
		select {
		case <-ctx.Done():
			return
		case it := <-o.ch:
			if it.mark != nil {
				close(it.mark)
				continue
			}
			_ = o.deliver(it.env) // without a connection it fails instantly: the inventory restores it
			if d := o.dropped.Load(); d != reported {
				o.log.Warn(o.what+" dropped: the queue to the panel was full", "new", d-reported, "total", d)
				reported = d
			}
		}
	}
}
