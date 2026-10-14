package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/store"
)

// collector stores everything the agent sends. send is a.send (notices and observed) and it
// can get stuck with stall, like a half-dead WS session; reply is the session's send
// with which Handle answers (it never gets stuck).
type collector struct {
	mu      sync.Mutex
	envs    []*mcsmv1.Envelope
	stuck   chan struct{}
	entered chan struct{} // receives a signal every time send gets stuck
	changed chan struct{}
}

func newCollector() *collector {
	return &collector{changed: make(chan struct{}, 1), entered: make(chan struct{}, 1024)}
}

func (c *collector) record(e *mcsmv1.Envelope) {
	c.mu.Lock()
	c.envs = append(c.envs, e)
	c.mu.Unlock()
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

func (c *collector) send(e *mcsmv1.Envelope) error {
	c.mu.Lock()
	stuck := c.stuck
	c.mu.Unlock()
	if stuck != nil {
		c.entered <- struct{}{}
		<-stuck
	}
	c.record(e)
	return nil
}

func (c *collector) reply(e *mcsmv1.Envelope) error {
	c.record(e)
	return nil
}

// stall gets send stuck until the returned function is called (it can be called more than once).
func (c *collector) stall() (unstall func()) {
	ch := make(chan struct{})
	c.mu.Lock()
	c.stuck = ch
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			c.stuck = nil
			c.mu.Unlock()
			close(ch)
		})
	}
}

func (c *collector) all() []*mcsmv1.Envelope {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*mcsmv1.Envelope(nil), c.envs...)
}

// waitFor waits, without sleeping, for cond to hold with what was received.
func (c *collector) waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !cond() {
		select {
		case <-c.changed:
		case <-deadline:
			t.Fatalf("did not arrive: %s", what)
		}
	}
}

// resp returns the response (Ack or Error) to request id.
func (c *collector) resp(id uint64) *mcsmv1.Envelope {
	for _, e := range c.all() {
		if e.Id == id && (e.GetAck() != nil || e.GetError() != nil) {
			return e
		}
	}
	return nil
}

// final returns a job's last finished JobProgress (OK or FAILED).
func (c *collector) final(jobID string) *mcsmv1.JobProgress {
	var out *mcsmv1.JobProgress
	for _, e := range c.all() {
		if p := e.GetJobProgress(); p != nil && p.JobId == jobID && p.Status != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
			out = p
		}
	}
	return out
}

func (c *collector) created() []*mcsmv1.BackupInfo {
	var out []*mcsmv1.BackupInfo
	for _, e := range c.all() {
		if m := e.GetBackupCreated(); m != nil {
			out = append(out, m.Backup)
		}
	}
	return out
}

func (c *collector) deleted() []*mcsmv1.BackupDeleted {
	var out []*mcsmv1.BackupDeleted
	for _, e := range c.all() {
		if m := e.GetBackupDeleted(); m != nil {
			out = append(out, m)
		}
	}
	return out
}

func (c *collector) inventory() *mcsmv1.BackupInventory {
	var inv *mcsmv1.BackupInventory
	for _, e := range c.all() {
		if m := e.GetBackupInventory(); m != nil {
			inv = m
		}
	}
	return inv
}

// manualClock: Until only fires if the time has already passed; tests move the clock by hand.
type manualClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) Until(t time.Time) <-chan time.Time {
	ch := make(chan time.Time, 1)
	if !t.After(c.Now()) {
		ch <- t
	}
	return ch
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// rconRec is a fake RCON. With block, save-all flush waits for it to be closed (and signals through
// reached); onCmd, if present, is called with each command before answering.
type rconRec struct {
	mu      sync.Mutex
	cmds    []string
	block   chan struct{}
	reached chan struct{}
	onCmd   func(cmd string)
}

func (r *rconRec) fn(ctx context.Context, host string, port uint16, password, cmd string) (string, error) {
	r.mu.Lock()
	r.cmds = append(r.cmds, cmd)
	block, reached, onCmd := r.block, r.reached, r.onCmd
	r.mu.Unlock()
	if onCmd != nil {
		onCmd(cmd)
	}
	if cmd == "save-all flush" && block != nil {
		close(reached)
		select {
		case <-block:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return "ok", nil
}

func (r *rconRec) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.cmds...)
}

// blockFlush makes the next save-all flush wait: it returns the arrival signal and the
// function that lets it continue.
func (r *rconRec) blockFlush() (reached <-chan struct{}, unblock func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.block, r.reached = make(chan struct{}), make(chan struct{})
	return r.reached, func() { close(r.block) }
}

const backupsSpecJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","backups":{"enabled":true,"cron":"* * * * *","keepDays":0,"keepCount":2,"excludes":["logs"],"onlyIfPlayersSince":false}}`

type backupEnv struct {
	a      *App
	fake   *docker.Fake
	st     *store.Store
	col    *collector
	rc     *rconRec
	clk    *manualClock
	cancel context.CancelFunc // cancels the agent's life context (a.life)
}

// newBackupEnv: agent with server "a" (slug alpha) running and a world on disk. The
// backup service has a manual clock and only its notice queue running (no scheduler
// or refresh: the tests move them by hand).
func newBackupEnv(t *testing.T, specJS string) *backupEnv {
	fake := docker.NewFake()
	return newBackupEnvEngine(t, fake, fake, specJS)
}

func newBackupEnvEngine(t *testing.T, eng docker.Engine, fake *docker.Fake, specJS string) *backupEnv {
	t.Helper()
	a, st := newAppEngine(t, eng)
	ctx, cancel := context.WithCancel(context.Background())
	e := &backupEnv{a: a, fake: fake, st: st, col: newCollector(), rc: &rconRec{},
		clk: &manualClock{now: time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)}, cancel: cancel}
	a.life = ctx
	a.send = e.col.send
	a.rcon = e.rc.fn
	a.bk = newBackupService(a, e.clk)
	a.bk.sleep = func(context.Context, time.Duration) error { return nil }
	// syncfs(2) waits for all the dirty data of the temporary directory's filesystem, also that of the
	// rest of `go test ./...` (in CI /tmp is on the runner's disk): it took the restores beyond settle.
	a.bk.syncFS = func(string) error { return nil }
	a.bk.loop(func() { a.bk.out.run(ctx) })
	t.Cleanup(func() {
		cancel()
		a.bk.wg.Wait()
		a.bk.loops.Wait()
	})
	sp := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJS)}
	if r := e.handle(1, &mcsmv1.ApplySpec{Server: sp}); r == nil || r.GetAck() == nil {
		t.Fatalf("ApplySpec: %+v", r)
	}
	e.writeLevel(t, "LEVEL-1")
	return e
}

// settle waits for the background jobs to finish and for the notice queue to have
// delivered everything they emitted.
func (e *backupEnv) settle(t *testing.T) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.a.bk.wg.Wait()
		mark := make(chan struct{})
		e.a.bk.out.ch <- outItem{mark: mark}
		<-mark
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the jobs did not finish")
	}
}

func (e *backupEnv) dataDir() string    { return filepath.Join(e.a.cfg.DataRoot, "alpha", "data") }
func (e *backupEnv) backupsDir() string { return filepath.Join(e.a.cfg.DataRoot, "alpha", "backups") }

func (e *backupEnv) writeLevel(t *testing.T, level string) {
	t.Helper()
	p := filepath.Join(e.dataDir(), "world", "level.dat")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(level), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readLevel(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "world", "level.dat"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (e *backupEnv) handle(id uint64, body any) *mcsmv1.Envelope {
	env := &mcsmv1.Envelope{Id: id}
	switch b := body.(type) {
	case *mcsmv1.BackupNow:
		env.Body = &mcsmv1.Envelope_BackupNow{BackupNow: b}
	case *mcsmv1.BackupRestore:
		env.Body = &mcsmv1.Envelope_BackupRestore{BackupRestore: b}
	case *mcsmv1.BackupDelete:
		env.Body = &mcsmv1.Envelope_BackupDelete{BackupDelete: b}
	case *mcsmv1.BackupList:
		env.Body = &mcsmv1.Envelope_BackupList{BackupList: b}
	case *mcsmv1.ApplySpec:
		env.Body = &mcsmv1.Envelope_ApplySpec{ApplySpec: b}
	case *mcsmv1.PowerAction:
		env.Body = &mcsmv1.Envelope_PowerAction{PowerAction: b}
	}
	e.a.Handle(context.Background(), env, e.col.reply)
	return e.col.resp(id)
}

func (e *backupEnv) running(t *testing.T) bool {
	t.Helper()
	cid := e.a.rec.ContainerID(context.Background(), "a")
	ins, err := e.fake.Inspect(context.Background(), cid)
	return err == nil && ins.Running
}

func (e *backupEnv) stopContainer(t *testing.T) {
	t.Helper()
	if err := e.fake.Stop(context.Background(), e.a.rec.ContainerID(context.Background(), "a"), time.Second); err != nil {
		t.Fatal(err)
	}
}

func fakeCalls(f *docker.Fake, prefix string) int {
	n := 0
	for _, c := range f.Calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func waitClosed(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("the backup did not reach the expected point")
	}
}

const (
	jobOK     = mcsmv1.JobStatus_JOB_STATUS_OK
	jobFailed = mcsmv1.JobStatus_JOB_STATUS_FAILED
)

func TestBackupNowOnRunningServer(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	if got := strings.Join(e.rc.list(), ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK || fin.Progress != 100 || fin.Type != jobs.TypeBackup {
		t.Fatalf("final = %+v", fin)
	}
	cr := e.col.created()
	if len(cr) != 1 || cr[0].Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_MANUAL || cr[0].ServerId != "a" || cr[0].Sha256 == "" {
		t.Fatalf("BackupCreated = %+v", cr)
	}
	if _, err := os.Stat(filepath.Join(e.backupsDir(), cr[0].Filename)); err != nil {
		t.Fatal(err)
	}
	if e.a.rec.Held("a") {
		t.Fatal("the reservation must be released when finished")
	}
	if !e.running(t) {
		t.Fatal("a hot backup does not stop the server")
	}
}

// assertDiscarded: the hot backup failed because the container stopped or restarted
// during it. The job says so without blaming save-on, there is no BackupCreated, nothing is left on
// disk (neither .partial nor .json) and the inventory does not list it.
func assertDiscarded(t *testing.T, e *backupEnv, jobID, detail string) {
	t.Helper()
	fin := e.col.final(jobID)
	if fin == nil || fin.Status != jobFailed {
		t.Fatalf("final = %+v", fin)
	}
	for _, want := range []string{"the server stopped or restarted during the backup", detail, "discarded"} {
		if !strings.Contains(fin.Message, want) {
			t.Fatalf("message = %q; missing %q", fin.Message, want)
		}
	}
	if strings.Contains(fin.Message, "save-on") {
		t.Fatalf("the message must not ask for save-on: %q", fin.Message)
	}
	if cr := e.col.created(); len(cr) != 0 {
		t.Fatalf("a discarded backup is not announced: %+v", cr)
	}
	if ents, _ := os.ReadDir(e.backupsDir()); len(ents) != 0 {
		t.Fatalf("files remain in backups: %v", ents)
	}
	if got := strings.Join(e.rc.list(), ","); got != "save-off,save-all flush" {
		t.Fatalf("RCON = %s; no save-on: the server starts with saving enabled", got)
	}
	e.handle(90, &mcsmv1.BackupList{})
	e.settle(t)
	if inv := e.col.inventory(); inv == nil || len(inv.Backups) != 0 {
		t.Fatalf("inventory = %+v", inv)
	}
}

// Plan 8 E2E case: mc-router (or docker stop, or a crash) stops the container during
// a hot backup and Minecraft saves the world when stopping, with or without save-off.
func TestBackupDiscardedWhenServerStopsDuringCopy(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-all flush" { // after save-off: the stop falls midway through the backup
			e.stopContainer(t)
			e.writeLevel(t, "LEVEL-SAVED-ON-STOP")
		}
	}
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	assertDiscarded(t, e, "job-1", "is no longer running")
	if e.a.rec.Held("a") {
		t.Fatal("the reservation must be released")
	}
}

// Stopped and started again (restart policy, mc-router waking it): same container,
// another StartedAt. What was read may mix the world from before and after.
func TestBackupDiscardedWhenServerRestartsDuringCopy(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-all flush" {
			e.stopContainer(t)
			if err := e.fake.Start(context.Background(), e.a.rec.ContainerID(context.Background(), "a")); err != nil {
				t.Error(err)
			}
		}
	}
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	assertDiscarded(t, e, "job-1", "restarted")
}

func TestBackupNowOnStoppedServerCopiesDirectly(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.stopContainer(t)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if cmds := e.rc.list(); len(cmds) != 0 {
		t.Fatalf("stopped: no RCON, there was %v", cmds)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK || len(e.col.created()) != 1 {
		t.Fatalf("final = %+v", fin)
	}
}

func TestBackupNowPreMigrationTrigger(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	stopServer(t, e, 9) // the backup prior to a migration requires the server to be stopped
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION})
	e.settle(t)
	if cr := e.col.created(); len(cr) != 1 || cr[0].Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION {
		t.Fatalf("BackupCreated = %+v", cr)
	}
}

func TestBackupNowDuplicateJobRunsOnce(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
		t.Fatalf("the duplicate also gets an Ack: %+v", r)
	}
	e.settle(t)
	if n := strings.Count(strings.Join(e.rc.list(), ","), "save-off"); n != 1 || len(e.col.created()) != 1 {
		t.Fatalf("the duplicate must not repeat the backup: save-off=%d created=%d", n, len(e.col.created()))
	}
	oks := 0
	for _, env := range e.col.all() {
		if p := env.GetJobProgress(); p != nil && p.JobId == "job-1" && p.Status == jobOK {
			oks++
		}
	}
	if oks != 2 {
		t.Fatalf("the duplicate must resend the stored result (OK x2), there were %d", oks)
	}
}

func TestApplySpecDuringBackupWaitsUntilItEnds(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached) // backup in progress, with save-off sent
	spec2 := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	r := e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	if r.GetAck() == nil {
		t.Fatalf("ApplySpec during the backup = %+v", r)
	}
	if fakeCalls(e.fake, "Remove") != 0 || fakeCalls(e.fake, "Create") != 1 {
		t.Fatalf("the ApplySpec must not recreate the container during the backup: %v", e.fake.Calls)
	}
	if v, _ := e.st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d during the backup", v)
	}
	unblock()
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	if fakeCalls(e.fake, "Remove") != 1 || fakeCalls(e.fake, "Create") != 2 {
		t.Fatalf("when the backup ends the spec is applied: %v", e.fake.Calls)
	}
	if v, _ := e.st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d after the backup", v)
	}
}

func TestBackupNowWhileBusy(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-2"})
	if r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("resp = %+v", r)
	}
	if r := e.handle(12, &mcsmv1.BackupRestore{ServerId: "a", JobId: "job-3", Filename: "alpha-20261012T040000.000Z-1.tar.zst"}); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("restoring during the backup = %+v", r)
	}
	if r := e.handle(13, &mcsmv1.BackupDelete{ServerId: "a", Filename: "alpha-20261012T040000.000Z-1.tar.zst"}); r.GetError().GetCode() != errcode.Busy || !strings.Contains(r.GetError().GetMessage(), "(backup)") {
		t.Fatalf("deleting during the backup = %+v", r)
	}
	unblock()
	e.settle(t)
	if fin := e.col.final("job-2"); fin == nil || fin.Status != jobFailed {
		t.Fatalf("job-2 = %+v", fin)
	}
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("job-1 = %+v", fin)
	}
}

func TestBackupNowValidation(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "other", JobId: "j"}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("foreign server = %+v", r)
	}
	if r := e.handle(11, &mcsmv1.BackupNow{ServerId: "a", JobId: "j", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE}); r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("unsupported trigger = %+v", r)
	}
	if r := e.handle(12, &mcsmv1.BackupNow{ServerId: "a"}); r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("without job_id = %+v", r)
	}
	e.settle(t)
	if e.col.final("j") != nil || e.a.rec.Held("a") {
		t.Fatal("a rejected request creates no job nor reserves the server")
	}
}

func TestRestoreKeepsPreviousDataAndRestarts(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	stops := fakeCalls(e.fake, "Stop")
	if r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK || fin.Type != jobs.TypeRestore {
		t.Fatalf("final = %+v", fin)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("the backup was not restored")
	}
	cr := e.col.created()
	pre := cr[len(cr)-1]
	if pre.Trigger != mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_RESTORE || !strings.HasPrefix(pre.Filename, "data.pre-restore-") {
		t.Fatalf("pre-restore = %+v", pre)
	}
	if readLevel(t, filepath.Join(e.a.cfg.DataRoot, "alpha", pre.Filename)) != "LEVEL-2" {
		t.Fatal("the previous data must be kept")
	}
	if fakeCalls(e.fake, "Stop") <= stops {
		t.Fatal("it must stop the server before restoring")
	}
	if !e.running(t) || e.a.rec.Held("a") {
		t.Fatal("when finished it is released and starts again (desired state running)")
	}
}

// The restore flushes the extracted backup to disk (backupService.syncFS) before swapping it with
// data, and waits for that flush however long it takes, with the server still reserved.
func TestRestoreFlushesTheExtractedBackupBeforeSwapping(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	reached, unblock := make(chan string, 1), make(chan struct{})
	e.a.bk.syncFS = func(dir string) error {
		reached <- dir
		<-unblock
		return nil
	}
	if r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	var dir string
	select {
	case dir = <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the restore did not flush the extracted backup")
	}
	if filepath.Dir(dir) != filepath.Dir(e.dataDir()) || dir == e.dataDir() || readLevel(t, dir) != "LEVEL-1" {
		t.Fatalf("flushed %q: it must be the extracted backup, next to data", dir)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-2" || e.col.final("job-r") != nil || !e.a.rec.Held("a") {
		t.Fatal("while the flush lasts nothing is swapped, the job goes on and the server stays reserved")
	}
	close(unblock)
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatalf("final = %+v", fin)
	}
}

// A file write that started before the reservation (e.g. a long upload) finishes
// before the restore sets data aside: otherwise it would end up in the pre-restore and the panel would
// consider it uploaded. While it waits, new mutations already answer busy.
func TestRestoreWaitsForInFlightFileWrites(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	leave := e.a.fileWrites.enter("a") // a mutation already in progress (it passed the Held check)
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.a.Handle(context.Background(), &mcsmv1.Envelope{Id: 20, Body: &mcsmv1.Envelope_BackupRestore{BackupRestore: &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"}}}, e.col.reply)
	}()
	e.col.waitFor(t, "wait notice", func() bool {
		for _, env := range e.col.all() {
			if p := env.GetJobProgress(); p != nil && p.JobId == "job-r" && strings.Contains(p.Message, "file operations in progress") {
				return true
			}
		}
		return false
	})
	if r := e.col.resp(20); r != nil {
		t.Fatalf("it responded before the write finished: %+v", r)
	}
	if !e.a.rec.Held("a") || readLevel(t, e.dataDir()) != "LEVEL-2" {
		t.Fatal("reserved and without touching data while it waits")
	}
	w := &mcsmv1.Envelope{Id: 30, Body: &mcsmv1.Envelope_FilesWrite{FilesWrite: &mcsmv1.FilesWrite{ServerId: "a", Path: "new.txt", Content: []byte("x")}}}
	if got := errCode(call(t, e.a, w)); got != errcode.Busy {
		t.Fatalf("a new write during the wait = %q; want busy", got)
	}
	leave()
	waitClosed(t, done)
	if r := e.col.resp(20); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("the backup was not restored")
	}
}

// If the writes in progress do not finish within the deadline, the restore does not start: busy,
// job failed, reservation released and data intact.
func TestRestoreBusyWhenFileWritesDoNotDrain(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.a.bk.drainWait = 0
	leave := e.a.fileWrites.enter("a")
	defer leave()
	stops := fakeCalls(e.fake, "Stop")
	r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
	if r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("resp = %+v", r)
	}
	if msg := r.GetError().GetMessage(); !strings.Contains(msg, "file operations") || strings.Contains(msg, "another backup") {
		t.Fatalf("message = %q", msg)
	}
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "file") {
		t.Fatalf("final = %+v", fin)
	}
	if e.a.rec.Held("a") || readLevel(t, e.dataDir()) != "LEVEL-2" || fakeCalls(e.fake, "Stop") != stops {
		t.Fatal("not restored: reservation released, data intact and the server not stopped")
	}
}

// gatedPullEngine blocks EnsureImage (the pull) while a barrier set with block is in place.
type gatedPullEngine struct {
	*docker.Fake
	mu   sync.Mutex
	gate chan struct{}
}

func (e *gatedPullEngine) block() (unblock func()) {
	ch := make(chan struct{})
	e.mu.Lock()
	e.gate = ch
	e.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			e.mu.Lock()
			e.gate = nil
			e.mu.Unlock()
			close(ch)
		})
	}
}

func (e *gatedPullEngine) EnsureImage(ctx context.Context, ref string) error {
	e.mu.Lock()
	gate := e.gate
	e.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return e.Fake.EnsureImage(ctx, ref)
}

// triggerClock is a manualClock whose Until only fires when the test sends through fire.
type triggerClock struct {
	*manualClock
	fire chan time.Time
}

func (c *triggerClock) Until(time.Time) <-chan time.Time { return c.fire }

// m-e: if the file writes do not drain, the restore answers busy right away. The
// reservation's release, which applies the spec that arrived during the wait (pull included),
// continues in the background with the agent's life context.
func TestRestoreDrainTimeoutReleasesInBackground(t *testing.T) {
	fake := docker.NewFake()
	eng := &gatedPullEngine{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	leave := e.a.fileWrites.enter("a")
	defer leave()
	fire := make(chan time.Time, 1)
	e.a.bk.clock = &triggerClock{manualClock: e.clk, fire: fire}
	resp := make(chan *mcsmv1.Envelope, 1)
	go func() { resp <- e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"}) }()
	e.col.waitFor(t, "the restore waiting for the file writes", func() bool {
		for _, env := range e.col.all() {
			if p := env.GetJobProgress(); p != nil && p.JobId == "job-r" && strings.Contains(p.Message, "Waiting") {
				return true
			}
		}
		return false
	})
	spec2 := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	if r := e.handle(30, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}}); r.GetAck() == nil {
		t.Fatalf("ApplySpec during the wait = %+v", r)
	}
	unblock := eng.block()
	defer unblock()
	fire <- time.Time{} // the drain expires
	select {
	case r := <-resp:
		if r.GetError().GetCode() != errcode.Busy {
			t.Fatalf("resp = %+v", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the busy response waited for the reservation's release (deferred spec with pull)")
	}
	unblock()
	e.settle(t)
	if e.a.rec.Held("a") {
		t.Fatal("the reservation must be released in the background")
	}
	if v, _ := e.st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d; the release applies the deferred spec", v)
	}
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed {
		t.Fatalf("final = %+v", fin)
	}
}

func TestRestoreRejectsBadName(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	r := e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: "../../etc/passwd", JobId: "job-r"})
	if r.GetError().GetCode() != errcode.InvalidRequest {
		t.Fatalf("invalid name = %+v", r)
	}
	e.settle(t)
	if e.col.final("job-r") != nil || e.a.rec.Held("a") {
		t.Fatal("it must not create a job nor reserve the server")
	}
}

// If the restore is left without data (ErrDataMissing), the server is not released: releasing would
// start it over an empty data and generate a new world. It stays reserved, stopped and with
// the error in Observed until the data directory returns; then it starts by itself.
func TestRestoreDataMissingKeepsServerDown(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	pre := filepath.Join(e.a.cfg.DataRoot, "alpha", "data.pre-restore-20261012T050000.000Z")
	e.a.bk.restore = func(_ context.Context, req backup.RestoreRequest) (backup.Meta, error) {
		// Both of the swap's renames fail: data set aside and unable to return.
		if err := os.Rename(req.DataDir, pre); err != nil {
			return backup.Meta{}, err
		}
		return backup.Meta{}, fmt.Errorf("%w: activate the backup: simulated; the original data remains in %s", backup.ErrDataMissing, pre)
	}
	e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, pre) {
		t.Fatalf("final = %+v", fin)
	}
	if !e.a.rec.Held("a") || e.running(t) {
		t.Fatal("the server must stay reserved and stopped")
	}
	ctx := context.Background()
	if obs := e.a.rec.Observe(ctx, "a"); !strings.Contains(obs.Error, "will not be started") || !strings.Contains(obs.Error, pre) {
		t.Fatalf("Observed.Error = %q", obs.Error)
	}
	e.a.reconcileAll(ctx) // tick
	waitBackground(t, e.a)
	if e.running(t) {
		t.Fatal("a tick must not start it")
	}
	if r := e.handle(30, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Power = %+v", r)
	}
	// Next review: the pre-restore without a .json goes back to data and the server starts.
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") || !e.running(t) || readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatalf("with the data back it must be released and start: held=%v running=%v", e.a.rec.Held("a"), e.running(t))
	}
	if obs := e.a.rec.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("Observed.Error = %q after recovering", obs.Error)
	}
}

func TestBackupListSendsInventory(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if r := e.handle(30, &mcsmv1.BackupList{}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	e.settle(t) // the inventory goes through the notice queue (same order as BackupCreated/Deleted)
	inv := e.col.inventory()
	if inv == nil || len(inv.ServerIds) != 1 || inv.ServerIds[0] != "a" || len(inv.Backups) != 1 {
		t.Fatalf("inventory = %+v", inv)
	}
	if len(inv.Jobs) != 1 || inv.Jobs[0].JobId != "job-1" || inv.Jobs[0].Status != jobOK {
		t.Fatalf("jobs = %+v", inv.Jobs)
	}
	// The panel correlates the inventory with its request: only the one answering its last
	// BackupList lets it mark backups as deleted and jobs as lost.
	if inv.RequestId != 30 {
		t.Fatalf("request_id = %d, want the BackupList's id (30)", inv.RequestId)
	}
	for _, env := range e.col.all() {
		if env.GetBackupInventory() != nil && env.Id != 0 {
			t.Fatalf("the inventory is an unsolicited message (id 0): %d", env.Id)
		}
	}
	if r := e.handle(31, &mcsmv1.BackupList{ServerId: "other"}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("foreign server = %+v", r)
	}
}

// An inventory larger than the limit would close the panel's WS (maxPayload) and each reconnection
// would ask for it again: a server that does not fit is omitted entirely (out of server_ids, so
// the panel does not mark its backups as deleted).
func TestBackupInventoryOmitsServersOverLimit(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	e.a.bk.inventoryLimit = 1
	e.handle(30, &mcsmv1.BackupList{})
	e.settle(t)
	if inv := e.col.inventory(); inv == nil || len(inv.ServerIds) != 0 || len(inv.Backups) != 0 || len(inv.Jobs) != 1 {
		t.Fatalf("inventory = %+v", inv)
	}
}

func TestBackupDelete(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	for i, bad := range []string{"../data", "data", "alpha", "beta-20261012T040000.000Z-1.tar.zst"} {
		if r := e.handle(uint64(40+i), &mcsmv1.BackupDelete{ServerId: "a", Filename: bad}); r.GetError().GetCode() != errcode.InvalidRequest {
			t.Errorf("deleting %q = %+v", bad, r)
		}
	}
	if r := e.handle(50, &mcsmv1.BackupDelete{ServerId: "a", Filename: name}); r.GetAck() == nil {
		t.Fatalf("resp = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(e.backupsDir(), name)); !os.IsNotExist(err) {
		t.Fatal("the backup must be deleted")
	}
	if _, err := os.Stat(e.dataDir()); err != nil {
		t.Fatal("the data is not touched")
	}
	// The deletion also goes out through the notice queue, behind an inventory that still listed it:
	// the panel does not resurrect it.
	e.settle(t)
	if d := e.col.deleted(); len(d) != 1 || d[0].Filename != name || d[0].Reason != "deleted" {
		t.Fatalf("BackupDeleted = %+v", d)
	}
	if r := e.handle(51, &mcsmv1.BackupDelete{ServerId: "other", Filename: name}); r.GetError().GetCode() != errcode.UnknownServer {
		t.Fatalf("foreign server = %+v", r)
	}
}

func TestScheduledBackupsArePrunedByKeepCount(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON) // * * * * *, keepCount 2, without onlyIfPlayersSince
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 1 || ids[0] != "a" {
		t.Fatalf("scheduled = %v", ids)
	}
	for i := 0; i < 3; i++ {
		e.a.bk.onSchedule("a")
		e.settle(t)
		e.clk.Advance(time.Minute)
	}
	metas, _ := backup.List(e.backupsDir(), "alpha")
	if len(metas) != 2 {
		t.Fatalf("keepCount=2 → %d backups", len(metas))
	}
	for _, m := range metas {
		if m.Trigger != backup.TriggerScheduled {
			t.Fatalf("trigger = %s", m.Trigger)
		}
	}
	if d := e.col.deleted(); len(d) != 1 || d[0].Reason != "pruned" || d[0].ServerId != "a" {
		t.Fatalf("BackupDeleted = %+v", d)
	}
	// a manual backup does not count toward keepCount nor is it pruned
	e.handle(60, &mcsmv1.BackupNow{ServerId: "a", JobId: "manual-1"})
	e.settle(t)
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if metas, _ = backup.List(e.backupsDir(), "alpha"); len(metas) != 3 {
		t.Fatalf("2 scheduled + 1 manual, there are %d", len(metas))
	}
}

// fire returns right away even if the backup has to wait (Hold waits, with no deadline, for the
// operation in progress on the server: here a long pull with the lock held). Otherwise the
// scheduler's loop would be left waiting and maxLate would skip other servers'
// firings.
func TestScheduleFireReturnsImmediately(t *testing.T) {
	fake := docker.NewFake()
	eng := &slowPull{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, backupsSpecJSON)
	release := eng.block()
	defer release()
	applied := make(chan struct{})
	go func() {
		defer close(applied)
		spec2 := strings.Replace(backupsSpecJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
		e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	}()
	waitClosed(t, eng.entered) // the ApplySpec is in the pull, with the server's lock
	returned := make(chan struct{})
	go func() {
		e.a.bk.onSchedule("a")
		close(returned)
	}()
	waitClosed(t, returned)
	release()
	waitClosed(t, applied)
	e.settle(t)
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 1 || metas[0].Trigger != backup.TriggerScheduled {
		t.Fatalf("the backup is made when the server becomes free: %+v", metas)
	}
}

// Between the firing and the execution the schedule may have been disabled (the refresh has not
// removed it yet) or the server may have been withdrawn: it is checked on execution.
func TestScheduledRechecksAtExecution(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	e.a.bk.refreshSchedules()
	disabled := strings.Replace(backupsSpecJSON, `"enabled":true`, `"enabled":false`, 1)
	e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(disabled)}})
	e.a.bk.onSchedule("a")
	e.a.bk.onSchedule("withdrawn")
	e.settle(t)
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 0 {
		t.Fatalf("schedule disabled: it must not back up, there are %d", len(metas))
	}
	for _, env := range e.col.all() {
		if env.GetJobProgress() != nil {
			t.Fatalf("it must not create jobs: %+v", env)
		}
	}
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 0 {
		t.Fatalf("the refresh removes the disabled schedule: %v", ids)
	}
}

// PATCH {spec:{backups:null}} in the panel arrives as a spec without the section: the periodic
// refresh (every scheduleRefreshEvery, 15 s) unschedules the server.
func TestScheduleRemovedWhenSpecLosesBackups(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 1 {
		t.Fatalf("scheduled at the start: %v", ids)
	}
	i := strings.Index(backupsSpecJSON, `,"backups":`)
	noBackups := backupsSpecJSON[:i] + "}"
	e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(noBackups)}})
	e.settle(t)
	e.a.bk.refreshSchedules()
	if ids := e.a.bk.sched.IDs(); len(ids) != 0 {
		t.Fatalf("without a backups section no schedule remains: %v", ids)
	}
}

func TestScheduledOnlyIfPlayersSince(t *testing.T) {
	e := newBackupEnv(t, strings.Replace(backupsSpecJSON, `"onlyIfPlayersSince":false`, `"onlyIfPlayersSince":true`, 1))
	count := func() int { m, _ := backup.List(e.backupsDir(), "alpha"); return len(m) }
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 1 {
		t.Fatal("the first backup is always made")
	}
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 1 {
		t.Fatal("without players since the last backup it is skipped")
	}
	e.a.bk.players.Observe("a", 2)
	e.clk.Advance(time.Minute)
	e.a.bk.onSchedule("a")
	e.settle(t)
	if count() != 2 {
		t.Fatal("with players since the last backup it is made")
	}
}

// Players arrive with each observed state (onObserved).
func TestObservedPlayersFeedTheWatch(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.status = func(context.Context, string, uint16) *mcsmv1.McStatus {
		return &mcsmv1.McStatus{Online: true, PlayersOnline: 3}
	}
	e.clk.Advance(time.Minute)
	e.a.rec.Observe(context.Background(), "a")
	if got := e.a.bk.players.LastSeen("a"); !got.Equal(e.clk.Now()) {
		t.Fatalf("LastSeen = %v", got)
	}
}

// A half-dead WS session (every send gets stuck) does not hold back the backup: the job's notices go
// through a queue and save-on goes out without waiting for any to be delivered.
func TestJobMessagesNeverBlockTheBackup(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	unstall := e.col.stall()
	defer unstall()
	savedOn := make(chan struct{})
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-on" {
			close(savedOn)
		}
	}
	acked := make(chan struct{})
	go func() { // Begin emits with the Tracker's mutex: it cannot wait for the send either
		defer close(acked)
		if r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"}); r.GetAck() == nil {
			t.Errorf("resp = %+v", r)
		}
	}()
	waitClosed(t, acked)
	waitClosed(t, savedOn)
	waitClosed(t, e.col.entered) // the first notice is still stuck in the send
	if e.col.final("job-1") != nil || len(e.col.created()) != 0 {
		t.Fatal("with the send stuck nothing can have been delivered")
	}
	unstall()
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
}

// slowPull blocks EnsureImage while a barrier set with block is in place and signals through entered
// the first time a pull is left waiting.
type slowPull struct {
	*docker.Fake
	mu      sync.Mutex
	gate    chan struct{}
	entered chan struct{}
	once    sync.Once
}

// block sets the barrier; the returned function removes it (it can be called more than once).
func (e *slowPull) block() (release func()) {
	gate := make(chan struct{})
	e.mu.Lock()
	e.gate, e.entered = gate, make(chan struct{})
	e.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

func (e *slowPull) EnsureImage(ctx context.Context, ref string) error {
	e.mu.Lock()
	g, entered := e.gate, e.entered
	e.mu.Unlock()
	if g != nil {
		e.once.Do(func() { close(entered) })
		select {
		case <-g:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return e.Fake.EnsureImage(ctx, ref)
}

// When the reservation is released, a long reconciliation (the deferred spec requires a slow pull) does not
// hold the job longer than releaseWait: the job finishes and the reconciliation continues in the
// background, with no deadline of its own, until the spec is applied.
func TestReleaseReconcilesInBackgroundAfterReleaseWait(t *testing.T) {
	fake := docker.NewFake()
	eng := &slowPull{Fake: fake}
	e := newBackupEnvEngine(t, eng, fake, specJSON)
	e.a.bk.releaseWait = 0
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	spec2 := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	e.handle(20, &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(spec2)}})
	release := eng.block()
	defer release()
	unblock()
	e.col.waitFor(t, "end of the job", func() bool { return e.col.final("job-1") != nil })
	if fin := e.col.final("job-1"); fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	if v, _ := e.st.Applied("a"); v != 1 {
		t.Fatalf("the pull is still blocked: applied = %d", v)
	}
	release()
	e.settle(t)
	if v, _ := e.st.Applied("a"); v != 2 || !e.running(t) {
		t.Fatalf("the background reconciliation finishes: applied = %d", v)
	}
}

// When the agent shuts down (life context cancelled) a hot backup aborts, its defer
// sends save-on and wait waits for it; the job ends up FAILED "interrupted" in the store.
func TestShutdownWaitsForBackupAndSendsSaveOn(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	reached, _ := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	e.cancel()
	if !e.a.bk.wait(10 * time.Second) {
		t.Fatal("wait must not expire: the backup ends when cancelled")
	}
	if got := strings.Join(e.rc.list(), ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("RCON = %s", got)
	}
	rec, _ := e.st.GetJob("job-1")
	if rec == nil || rec.Status != jobFailed || !strings.Contains(rec.Message, "interrupted") {
		t.Fatalf("job = %+v", rec)
	}
	if e.a.bk.spawn(func() {}) {
		t.Fatal("after wait no new jobs are launched")
	}
}

// On startup: save-on to the running servers whose backup was left half done (before marking
// the job: if the agent falls again, it is retried) and then the RUNNING jobs become FAILED.
func TestRecoverResumesSavesAndFailsInterruptedJobs(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	put := func(id, typ string) {
		if err := e.st.PutJob(&mcsmv1.JobRecord{JobId: id, ServerId: "a", Type: typ, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
			t.Fatal(err)
		}
	}
	put("backup", jobs.TypeBackup)
	put("restore", jobs.TypeRestore)
	var statusAtSaveOn mcsmv1.JobStatus
	e.rc.onCmd = func(cmd string) {
		if cmd == "save-on" {
			rec, _ := e.st.GetJob("backup")
			statusAtSaveOn = rec.Status
		}
	}
	e.a.bk.recoverAtStart(context.Background())
	if got := strings.Join(e.rc.list(), ","); got != "save-on" || statusAtSaveOn != mcsmv1.JobStatus_JOB_STATUS_RUNNING {
		t.Fatalf("RCON = %q, job state when sending save-on = %v", got, statusAtSaveOn)
	}
	for _, id := range []string{"backup", "restore"} {
		rec, _ := e.st.GetJob(id)
		if rec.Status != jobFailed || !strings.Contains(rec.Message, "interrupted") {
			t.Fatalf("%s = %+v", id, rec)
		}
	}

	// With the server stopped save-on is not needed.
	e2 := newBackupEnv(t, specJSON)
	e2.stopContainer(t)
	if err := e2.st.PutJob(&mcsmv1.JobRecord{JobId: "backup", ServerId: "a", Type: jobs.TypeBackup, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
		t.Fatal(err)
	}
	e2.a.bk.recoverAtStart(context.Background())
	if cmds := e2.rc.list(); len(cmds) != 0 {
		t.Fatalf("stopped: no RCON, there was %v", cmds)
	}
}

// On startup after a crash between a restore's two renames: the original data
// goes back to data before reconciling and the leftovers are deleted.
func TestRecoverRollsBackInterruptedRestore(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.stopContainer(t) // the restore had stopped it
	parent := filepath.Dir(e.dataDir())
	pre := filepath.Join(parent, "data.pre-restore-20261012T040000.000Z")
	staging := filepath.Join(parent, "data.restoring-20261012T040000.000Z")
	if err := os.Rename(e.dataDir(), pre); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staging, "world"), 0o755); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(e.backupsDir(), "alpha-20261012T040000.000Z-1.tar.zst.partial")
	if err := os.MkdirAll(e.backupsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverAtStart(context.Background())
	if readLevel(t, e.dataDir()) != "LEVEL-1" {
		t.Fatal("the original data must go back to data")
	}
	for _, p := range []string{pre, staging, partial} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Fatalf("%s must disappear", p)
		}
	}
	if e.a.rec.Held("a") {
		t.Fatal("recovered: it is not blocked")
	}
	e.a.reconcileAll(context.Background())
	waitBackground(t, e.a)
	if !e.running(t) {
		t.Fatal("after recovering, the reconciliation starts it")
	}
}

// If the data cannot be returned on startup, the server does not start: it stays reserved
// with the error in Observed (without scheduled backups, which would only fail) and it is released by itself
// when data exists again.
func TestRecoverUnrecoverableDataBlocksServer(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	e.stopContainer(t)
	if err := os.Rename(e.dataDir(), e.dataDir()+".aside"); err != nil {
		t.Fatal(err)
	}
	failing := func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulated", backup.ErrDataMissing)
	}
	e.a.bk.recoverDisk = failing
	e.a.bk.recoverAtStart(context.Background())
	ctx := context.Background()
	if !e.a.rec.Held("a") {
		t.Fatal("it must stay reserved")
	}
	if obs := e.a.rec.Observe(ctx, "a"); !strings.Contains(obs.Error, "will not be started") || !strings.Contains(obs.Error, e.dataDir()) {
		t.Fatalf("Observed.Error = %q", obs.Error)
	}
	e.a.reconcileAll(ctx)
	waitBackground(t, e.a)
	if e.running(t) {
		t.Fatal("it must not start without data")
	}
	e.a.bk.onSchedule("a")
	e.a.bk.checkBlocked() // still without data
	e.settle(t)
	if !e.a.rec.Held("a") {
		t.Fatal("without data it stays blocked")
	}
	for _, env := range e.col.all() {
		if env.GetJobProgress() != nil {
			t.Fatalf("blocked: the scheduled backup is skipped without creating a job: %+v", env)
		}
	}
	if err := os.Rename(e.dataDir()+".aside", e.dataDir()); err != nil { // someone returns them
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = backup.RecoverInterrupted
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") || !e.running(t) {
		t.Fatal("with data back it is released and starts")
	}
}

// A blocked server that the panel withdraws is released (the deletion of its container is
// completed by the reservation's release).
func TestBlockedServerRemovedByPanelIsReleased(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.bk.recoverDisk = func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulated", backup.ErrDataMissing)
	}
	if err := os.RemoveAll(e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverAtStart(context.Background())
	if !e.a.rec.Held("a") {
		t.Fatal("it must stay reserved")
	}
	e.a.Handle(context.Background(), syncMsg(5, nil, "a"), e.col.reply)
	waitBackground(t, e.a)
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") {
		t.Fatal("withdrawn: it is released")
	}
	if list, _ := e.fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatalf("the release completes the deletion: %+v", list)
	}
}

// listFailEngine makes ListManaged fail while fail is active (Docker loaded or down).
type listFailEngine struct {
	*docker.Fake
	mu   sync.Mutex
	fail bool
}

func (e *listFailEngine) setFail(v bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.fail = v
}

func (e *listFailEngine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	e.mu.Lock()
	fail := e.fail
	e.mu.Unlock()
	if fail {
		return nil, fmt.Errorf("docker is not responding")
	}
	return e.Fake.ListManaged(ctx)
}

func newListFailEnv(t *testing.T) (*backupEnv, *listFailEngine) {
	fake := docker.NewFake()
	eng := &listFailEngine{Fake: fake}
	return newBackupEnvEngine(t, eng, fake, specJSON), eng
}

// If it cannot be checked whether the server is running, the backup fails: copying "cold" a
// server that is running (without save-off) would give a corrupt backup with a valid sha256.
func TestBackupFailsWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	eng.setFail(true)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	fin := e.col.final("job-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "could not check") {
		t.Fatalf("final = %+v", fin)
	}
	if cmds := e.rc.list(); len(cmds) != 0 || len(e.col.created()) != 0 {
		t.Fatalf("neither RCON nor backup: %v, %+v", cmds, e.col.created())
	}
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 0 {
		t.Fatalf("no backup must remain: %+v", metas)
	}
}

// If the container cannot be checked, the restore does not swap data: with the
// server running, it would keep writing to the one that would become the pre-restore.
func TestRestoreFailsWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	e.writeLevel(t, "LEVEL-2")
	e.clk.Advance(time.Hour)
	stops := fakeCalls(e.fake, "Stop")
	eng.setFail(true)
	e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
	e.settle(t)
	if fin := e.col.final("job-r"); fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "could not check") {
		t.Fatalf("final = %+v", fin)
	}
	if readLevel(t, e.dataDir()) != "LEVEL-2" || fakeCalls(e.fake, "Stop") != stops {
		t.Fatal("data intact and the server untouched")
	}
	if pre, _ := backup.ListPreRestore(e.dataDir()); len(pre) != 0 {
		t.Fatalf("without pre-restore: %+v", pre)
	}
}

// On startup, if Docker does not respond, save-on is sent anyway (it is idempotent): otherwise,
// FailInterrupted would forget the job and the world would stay in save-off.
func TestRecoverSendsSaveOnWhenDockerCannotBeQueried(t *testing.T) {
	e, eng := newListFailEnv(t)
	if err := e.st.PutJob(&mcsmv1.JobRecord{JobId: "backup", ServerId: "a", Type: jobs.TypeBackup, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}); err != nil {
		t.Fatal(err)
	}
	eng.setFail(true)
	e.a.bk.recoverAtStart(context.Background())
	if got := strings.Join(e.rc.list(), ","); got != "save-on" {
		t.Fatalf("RCON = %q", got)
	}
}

// Without space for the backup, the job fails saying how much is missing and without touching the server.
func TestBackupWithoutSpaceFailsBeforeSaveOff(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.a.bk.freeSpace = func(string) (uint64, error) { return 1 << 20, nil }
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	fin := e.col.final("job-1")
	if fin == nil || fin.Status != jobFailed || !strings.Contains(fin.Message, "short") {
		t.Fatalf("final = %+v", fin)
	}
	if cmds := e.rc.list(); len(cmds) != 0 {
		t.Fatalf("without space there is no save-off: %v", cmds)
	}
}

// m9: without data after a completed restore (pre-restore with .json) an empty world is not
// started: it stays blocked until data exists (here, an empty folder on purpose).
func TestRecoverBlocksMissingDataAfterCompletedRestore(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	e.clk.Advance(time.Hour)
	e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: e.col.created()[0].Filename, JobId: "job-r"})
	e.settle(t)
	e.stopContainer(t)
	if err := os.RemoveAll(e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverAtStart(context.Background())
	ctx := context.Background()
	if !e.a.rec.Held("a") {
		t.Fatal("it must stay blocked")
	}
	if obs := e.a.rec.Observe(ctx, "a"); !strings.Contains(obs.Error, "data.pre-restore-") {
		t.Fatalf("Observed.Error = %q", obs.Error)
	}
	e.a.reconcileAll(ctx)
	waitBackground(t, e.a)
	if e.running(t) {
		t.Fatal("it must not start an empty world")
	}
	if err := os.Mkdir(e.dataDir(), 0o755); err != nil { // the administrator chooses to start from scratch
		t.Fatal(err)
	}
	e.a.bk.checkBlocked()
	e.settle(t)
	if e.a.rec.Held("a") || !e.running(t) {
		t.Fatal("with data it is released and starts")
	}
}

// m5: a firing on a busy server (cron faster than the backup) is skipped with a
// log warning, without creating a FAILED job on every firing.
func TestScheduledSkipsBusyServerWithoutJob(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	reached, unblock := e.rc.blockFlush()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	waitClosed(t, reached)
	e.a.bk.scheduled("a") // the firing, inline: it returns on seeing the server reserved
	unblock()
	e.settle(t)
	for _, env := range e.col.all() {
		if p := env.GetJobProgress(); p != nil && p.JobId != "job-1" {
			t.Fatalf("the skipped firing must not create a job: %+v", p)
		}
	}
	if metas, _ := backup.List(e.backupsDir(), "alpha"); len(metas) != 1 {
		t.Fatalf("only the manual backup: %d", len(metas))
	}
}

// m5: without data (a server that has never started yet) the firing is skipped without a job.
func TestScheduledSkipsServerWithoutData(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := os.RemoveAll(e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.onSchedule("a")
	e.settle(t)
	for _, env := range e.col.all() {
		if env.GetJobProgress() != nil {
			t.Fatalf("without data it must not create a job: %+v", env)
		}
	}
	if e.a.rec.Held("a") {
		t.Fatal("it must not stay reserved")
	}
}

// hostRcon is a fake RCON per server: save-all flush waits at its host's barrier if
// it has one and signals on arrival.
type hostRcon struct {
	mu      sync.Mutex
	cmds    map[string][]string
	gates   map[string]chan struct{}
	reached map[string]chan struct{}
}

func newHostRcon() *hostRcon {
	return &hostRcon{cmds: map[string][]string{}, gates: map[string]chan struct{}{}, reached: map[string]chan struct{}{}}
}

func (r *hostRcon) gate(host string) (reached <-chan struct{}, open func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, re := make(chan struct{}), make(chan struct{})
	r.gates[host], r.reached[host] = g, re
	var once sync.Once
	return re, func() { once.Do(func() { close(g) }) }
}

func (r *hostRcon) fn(ctx context.Context, host string, _ uint16, _, cmd string) (string, error) {
	r.mu.Lock()
	r.cmds[host] = append(r.cmds[host], cmd)
	g, re := r.gates[host], r.reached[host]
	r.mu.Unlock()
	if cmd == "save-all flush" && g != nil {
		close(re)
		select {
		case <-g:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return "ok", nil
}

func (r *hostRcon) list(host string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.cmds[host]...)
}

// addServer registers another running server with its world on disk.
func (e *backupEnv) addServer(t *testing.T, id, slug string, port, msgID int) {
	t.Helper()
	js := strings.Replace(specJSON, `"game":25565`, fmt.Sprintf(`"game":%d`, port), 1)
	sp := &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(js)}
	if r := e.handle(uint64(msgID), &mcsmv1.ApplySpec{Server: sp}); r.GetAck() == nil {
		t.Fatalf("ApplySpec %s: %+v", id, r)
	}
	p := filepath.Join(e.a.cfg.DataRoot, slug, "data", "world", "level.dat")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("LEVEL-1"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// m10: at most maxParallelJobs backups or restores at once on the node. The third
// waits in the queue BEFORE save-off (its world keeps saving) and does not fail: it starts as soon as
// a slot is free.
func TestBackupsQueueBeyondNodeLimit(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.addServer(t, "b", "beta", 25566, 2)
	e.addServer(t, "c", "gamma", 25567, 3)
	rc := newHostRcon()
	e.a.rcon = rc.fn
	reachedA, openA := rc.gate("mcsm-alpha")
	reachedB, openB := rc.gate("mcsm-beta")
	defer openA()
	defer openB()
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-a"})
	e.handle(11, &mcsmv1.BackupNow{ServerId: "b", JobId: "job-b"})
	waitClosed(t, reachedA)
	waitClosed(t, reachedB)
	if r := e.handle(12, &mcsmv1.BackupNow{ServerId: "c", JobId: "job-c"}); r.GetAck() == nil {
		t.Fatalf("the third is accepted and waits: %+v", r)
	}
	queued := func() bool {
		for _, env := range e.col.all() {
			if p := env.GetJobProgress(); p != nil && p.JobId == "job-c" && strings.Contains(p.Message, "Queued") {
				return true
			}
		}
		return false
	}
	e.col.waitFor(t, "job-c queued", queued)
	if cmds := rc.list("mcsm-gamma"); len(cmds) != 0 {
		t.Fatalf("queued there is no save-off: %v", cmds)
	}
	openA() // job-a finishes and job-c takes its slot, with job-b still in progress
	e.col.waitFor(t, "end of job-c", func() bool { return e.col.final("job-c") != nil })
	openB()
	e.settle(t)
	for _, id := range []string{"job-a", "job-b", "job-c"} {
		if fin := e.col.final(id); fin == nil || fin.Status != jobOK {
			t.Fatalf("%s = %+v", id, fin)
		}
	}
	if got := strings.Join(rc.list("mcsm-gamma"), ","); got != "save-off,save-all flush,save-on" {
		t.Fatalf("gamma RCON = %s", got)
	}
}

// Periodic inventory: the agent sends it unprompted (id 0), with the real state of
// the jobs. It restores a dropped terminal notice (job "running" forever in the panel) and
// covers a failed BackupList that the panel does not retry until the next Hello.
func TestPeriodicInventoryCarriesJobsAndBackups(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	e.a.bk.periodicInventory()
	e.settle(t)
	inv := e.col.inventory()
	if inv == nil || len(inv.ServerIds) != 1 || len(inv.Backups) != 1 || len(inv.Jobs) != 1 || inv.Jobs[0].Status != jobOK {
		t.Fatalf("inventory = %+v", inv)
	}
	if inv.RequestId != 0 {
		t.Fatalf("the periodic one answers no request: request_id = %d", inv.RequestId)
	}
}

// The notice queue is FIFO and the inventory is computed and queued under the same mutex as
// BackupCreated/BackupDeleted: with the send stuck, whatever enters after the inventory
// goes out after it.
func TestInventoryAndNoticesShareTheQueue(t *testing.T) {
	e := newBackupEnv(t, specJSON)
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	name := e.col.created()[0].Filename
	unstall := e.col.stall()
	defer unstall()
	e.a.bk.periodicInventory()
	e.handle(20, &mcsmv1.BackupDelete{ServerId: "a", Filename: name})
	unstall()
	e.settle(t)
	invAt, delAt := -1, -1
	for i, env := range e.col.all() {
		if env.GetBackupInventory() != nil {
			invAt = i
		}
		if d := env.GetBackupDeleted(); d != nil && d.Filename == name {
			delAt = i
		}
	}
	if invAt < 0 || delAt < invAt {
		t.Fatalf("the inventory (which still lists the backup) must arrive before its BackupDeleted: inv=%d del=%d", invAt, delAt)
	}
}
