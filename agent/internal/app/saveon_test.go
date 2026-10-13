package app

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
)

// failingSaveOn makes save-on fail while fail is true; everything else goes to the environment's fake RCON.
func failingSaveOn(e *backupEnv, fail *atomic.Bool) {
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" && fail.Load() {
			return "", errors.New("rcon down")
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
}

// eventKinds delivers whatever is in the event queue and returns the kinds received.
func eventKinds(t *testing.T, e *backupEnv) []string {
	t.Helper()
	mark := make(chan struct{})
	e.a.events.ch <- outItem{mark: mark}
	select {
	case <-mark:
	case <-time.After(3 * time.Second):
		t.Fatal("the event queue does not advance")
	}
	var out []string
	for _, env := range e.col.all() {
		if ev := env.GetEvent(); ev != nil {
			out = append(out, ev.Kind)
		}
	}
	return out
}

func startEvents(t *testing.T, e *backupEnv) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go e.a.events.run(ctx)
}

func TestSaveOnFailureIsRetriedUntilItWorks(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	startEvents(t, e)
	var fail atomic.Bool
	fail.Store(true)
	failingSaveOn(e, &fail)
	if r := e.handle(2, &mcsmv1.BackupNow{ServerId: "a", JobId: "j1"}); r.GetAck() == nil {
		t.Fatalf("BackupNow: %+v", r)
	}
	e.settle(t)
	if f := e.col.final("j1"); f == nil || f.Status != mcsmv1.JobStatus_JOB_STATUS_FAILED {
		t.Fatalf("the backup with a failed save-on fails: %+v", f)
	}
	if ids, _ := e.st.SaveOnPending(); !slices.Equal(ids, []string{"a"}) {
		t.Fatalf("pending = %v", ids)
	}
	retrySettle(t, e) // still failing
	if ids, _ := e.st.SaveOnPending(); len(ids) != 1 {
		t.Fatalf("pending = %v", ids)
	}
	fail.Store(false)
	e.clk.Advance(saveOnBackoffMin) // after the first failure, the minimum wait
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pending = %v", ids)
	}
	if got := eventKinds(t, e); !slices.Equal(got, []string{KindSaveOnPending, KindSaveOnResumed}) {
		t.Fatalf("events = %v", got)
	}
}

func TestSaveOnPendingForgottenWhenStoppedAndSkippedWhenHeld(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	release, err := e.a.rec.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	before := len(e.rc.list())
	retrySettle(t, e)
	if len(e.rc.list()) != before {
		t.Fatal("with the server reserved RCON is not touched")
	}
	release(context.Background())
	if r := e.handle(3, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop: %+v", r)
	}
	before = len(e.rc.list())
	retrySettle(t, e) // reserved does not count as a failure: there is no wait
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("stopped: it is forgotten; pending = %v", ids)
	}
	if len(e.rc.list()) != before {
		t.Fatal("stopped, save-on is not sent")
	}
}

func TestResumeAtStartMarksPendingWhenSaveOnFails(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	var fail atomic.Bool
	fail.Store(true)
	failingSaveOn(e, &fail)
	if err := e.st.PutJob(&mcsmv1.JobRecord{JobId: "j0", ServerId: "a", Type: jobs.TypeBackup, Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING}); err != nil {
		t.Fatal(err)
	}
	e.a.bk.resumeInterrupted(context.Background())
	if ids, _ := e.st.SaveOnPending(); !slices.Equal(ids, []string{"a"}) {
		t.Fatalf("pending = %v", ids)
	}
}

// A hot backup that starts while retrySaveOn sends save-on cannot sneak in: the server is
// reserved during the RCON (otherwise, the save-on would re-enable saving midway through its tar).
func TestRetrySaveOnReservesTheServerDuringTheRcon(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var sent atomic.Bool
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			sent.Store(true)
			release, err := e.a.rec.Hold("a", holdBackup) // the backup arrives right now
			if err == nil {
				release(context.Background())
				t.Error("a backup was able to reserve the server midway through the save-on")
			} else if !errors.Is(err, reconcile.ErrBusy) {
				t.Errorf("err = %v", err)
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	retrySettle(t, e)
	if !sent.Load() {
		t.Fatal("save-on was not sent")
	}
	if e.a.rec.Held("a") {
		t.Fatal("the save-on's reservation is released when finished")
	}
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pending = %v", ids)
	}
}

// retrySettle launches a pass of save-on retries and waits for them to finish.
func retrySettle(t *testing.T, e *backupEnv) {
	t.Helper()
	e.a.bk.retrySaveOn(context.Background())
	e.settle(t)
}

// saveOnCounter makes save-on fail while fail is true and counts the attempts.
func saveOnCounter(e *backupEnv, fail *atomic.Bool) *atomic.Int32 {
	var n atomic.Int32
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			n.Add(1)
			if fail.Load() {
				return "", errors.New("rcon down")
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	return &n
}

// S3: after each failure, the server waits 30 s, 60 s, 120 s… up to 5 min; success resets the wait.
func TestRetrySaveOnBacksOffPerServer(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var fail atomic.Bool
	fail.Store(true)
	n := saveOnCounter(e, &fail)
	for i, wait := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute} {
		retrySettle(t, e)
		if got := n.Load(); got != int32(i+1) {
			t.Fatalf("attempt %d: save-on sent %d times", i+1, got)
		}
		e.clk.Advance(wait - time.Second)
		retrySettle(t, e)
		if got := n.Load(); got != int32(i+1) {
			t.Fatalf("attempt %d: before %v it is not retried (%d)", i+1, wait, got)
		}
		e.clk.Advance(time.Second)
	}
	fail.Store(false)
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pending = %v", ids)
	}
	// A new failure after the success is retried right away: the wait started from zero.
	before := n.Load()
	if err := e.st.MarkSaveOnPending("a", time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	retrySettle(t, e)
	if n.Load() != before+1 {
		t.Fatal("after a success the wait resets")
	}
}

// S3: stopping the server forgets the pending one and its wait.
func TestRetrySaveOnBackoffResetsWhenStopped(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var fail atomic.Bool
	fail.Store(true)
	n := saveOnCounter(e, &fail)
	retrySettle(t, e)
	retrySettle(t, e)
	if n.Load() != 1 {
		t.Fatalf("attempts = %d", n.Load())
	}
	if r := e.handle(3, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop: %+v", r)
	}
	e.clk.Advance(saveOnBackoffMin)
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("stopped: pending = %v", ids)
	}
	if r := e.handle(4, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}); r.GetAck() == nil {
		t.Fatalf("start: %+v", r)
	}
	if err := e.st.MarkSaveOnPending("a", time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	before := n.Load()
	retrySettle(t, e)
	if n.Load() != before+1 {
		t.Fatal("after stopping it, the wait starts from zero")
	}
}

// S3: the retry's RCON has a short deadline (the server stays reserved while it lasts).
func TestRetrySaveOnUsesAShortRconTimeout(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var left time.Duration
	var hasDeadline bool
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			var dl time.Time
			dl, hasDeadline = ctx.Deadline()
			left = time.Until(dl)
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	retrySettle(t, e)
	if !hasDeadline || left <= 0 || left > saveOnRetryTimeout {
		t.Fatalf("RCON deadline = %v (with deadline %v), maximum %v", left, hasDeadline, saveOnRetryTimeout)
	}
}

// S3: each retry goes in its own goroutine (the pass does not wait for the RCON) and never two for the same server at once.
func TestRetrySaveOnRunsInBackgroundWithoutOverlap(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var n atomic.Int32
	entered, unblock := make(chan struct{}, 4), make(chan struct{})
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			n.Add(1)
			entered <- struct{}{}
			select {
			case <-unblock:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	passDone := make(chan struct{})
	go func() {
		e.a.bk.retrySaveOn(context.Background())
		close(passDone)
	}()
	select {
	case <-passDone:
	case <-time.After(hangGuard):
		t.Fatal("the pass waits for the RCON")
	}
	select {
	case <-entered:
	case <-time.After(hangGuard):
		t.Fatal("the retry did not start")
	}
	e.a.bk.retrySaveOn(context.Background()) // the previous one is still in progress: they do not overlap
	e.a.bk.retrySaveOn(context.Background())
	if got := n.Load(); got != 1 {
		t.Fatalf("save-on in progress at once = %d", got)
	}
	close(unblock)
	e.settle(t)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pending = %v", ids)
	}
}

const hangGuard = 10 * time.Second // only prevents hanging the suite

// deadlineEngine records, while watch is active, the deadline left for each Docker query.
type deadlineEngine struct {
	docker.Engine
	watch atomic.Bool
	mu    sync.Mutex
	left  []time.Duration // -1: no deadline
}

func (e *deadlineEngine) note(ctx context.Context) {
	if !e.watch.Load() {
		return
	}
	left := time.Duration(-1)
	if dl, ok := ctx.Deadline(); ok {
		left = time.Until(dl)
	}
	e.mu.Lock()
	e.left = append(e.left, left)
	e.mu.Unlock()
}

func (e *deadlineEngine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	e.note(ctx)
	return e.Engine.ListManaged(ctx)
}

func (e *deadlineEngine) Inspect(ctx context.Context, id string) (*docker.Inspect, error) {
	e.note(ctx)
	return e.Engine.Inspect(ctx, id)
}

// N2: with the server reserved, the Docker check (isRunning) is also within the retry's 5 s.
func TestRetrySaveOnBoundsTheDockerCheckToo(t *testing.T) {
	fake := docker.NewFake()
	eng := &deadlineEngine{Engine: fake}
	e := newBackupEnvEngine(t, eng, fake, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var rconLeft time.Duration
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			eng.watch.Store(false) // what comes after (the reservation's release reconciles) does not count
			if dl, ok := ctx.Deadline(); ok {
				rconLeft = time.Until(dl)
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	eng.watch.Store(true)
	retrySettle(t, e)
	eng.mu.Lock()
	defer eng.mu.Unlock()
	if len(eng.left) == 0 {
		t.Fatal("Docker was not queried")
	}
	for _, l := range eng.left {
		if l < 0 || l > saveOnRetryTimeout {
			t.Fatalf("Docker query with the server reserved and deadline %v (maximum %v)", l, saveOnRetryTimeout)
		}
	}
	if rconLeft <= 0 || rconLeft > eng.left[len(eng.left)-1] {
		t.Fatalf("the RCON shares the same deadline: %v after %v", rconLeft, eng.left)
	}
}
