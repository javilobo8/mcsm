package reconcile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
)

const specJSON3G = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"3G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

const runningState = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

func TestHoldDefersApplyUntilRelease(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	before := len(fake.Calls)
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: runningState, SpecJson: []byte(specJSON3G)}); err != nil {
		t.Fatal(err)
	}
	r.ReconcileAll(ctx)
	for _, c := range fake.Calls[before:] {
		if strings.HasPrefix(c, "Stop") || strings.HasPrefix(c, "Remove") || strings.HasPrefix(c, "Create") {
			t.Fatalf("it must not touch the container during the reservation: %v", fake.Calls[before:])
		}
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d, want 1", v)
	}
	if sp, _ := st.GetSpec("a"); sp.Version != 2 {
		t.Fatal("the new spec must be stored")
	}
	release(ctx)
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("after release applied = %d, want 2", v)
	}
	if calls(fake, "Remove") != 1 || calls(fake, "Create") != 2 {
		t.Fatalf("it must recreate on release: %v", fake.Calls)
	}
	release(ctx) // idempotent
	if calls(fake, "Create") != 2 {
		t.Fatal("releasing twice repeats nothing")
	}
}

func TestHoldRejectsSecondHoldPowerAndRemove(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Held("a") || r.Held("b") {
		t.Fatal("Held")
	}
	if _, err := r.Hold("a", "backup"); !errors.Is(err, ErrBusy) || !strings.Contains(err.Error(), "restore") {
		t.Fatalf("second reservation = %v", err)
	}
	stops := calls(fake, "Stop")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); !errors.Is(err, ErrBusy) {
		t.Fatalf("Power = %v", err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("Power must not touch the reserved container")
	}
	if err := r.Remove(ctx, "a", false); !errors.Is(err, ErrBusy) {
		t.Fatalf("Remove = %v", err)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("Remove must not delete the spec of a reserved server")
	}
	release(ctx)
	if r.Held("a") {
		t.Fatal("it must be released")
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
}

func TestHoldWaitsForOperationInProgress(t *testing.T) {
	r, st, _, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	unlock := r.lock("a") // another operation on the server in progress
	done := make(chan error, 1)
	go func() {
		_, err := r.Hold("a", "backup")
		done <- err
	}()
	select {
	case <-done:
		t.Fatal("Hold must not return while another operation holds the server's lock")
	default:
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Hold did not return after releasing the lock")
	}
}

func TestReleaseRestartsServerStoppedDuringHold(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	cid := r.ContainerID(ctx, "a")
	if err := fake.Stop(ctx, cid, StopTimeout); err != nil { // the restore stops it
		t.Fatal(err)
	}
	r.ReconcileAll(ctx)
	if ins, _ := fake.Inspect(ctx, cid); ins.Running {
		t.Fatal("during the reservation nobody must start it")
	}
	release(ctx)
	if ins, _ := fake.Inspect(ctx, cid); !ins.Running {
		t.Fatal("on release it returns to its desired state (running)")
	}
}

// A reservation without a reason is still a reservation: the empty reason cannot disable
// the checks.
func TestHoldWithEmptyReasonStillHolds(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Held("a") {
		t.Fatal("Held with an empty reason")
	}
	stops := calls(fake, "Stop")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); !errors.Is(err, ErrBusy) {
		t.Fatalf("Power = %v", err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("Power must not touch the reserved container")
	}
	release(ctx)
	if r.Held("a") {
		t.Fatal("it must be released")
	}
}

// Concurrent reservations and releases with ticks and power actions: no races
// (-race), no deadlocks and with the server in its desired state at the end.
func TestHoldConcurrentWithTicksAndPower(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			release, err := r.Hold("a", "backup")
			if err != nil {
				if !errors.Is(err, ErrBusy) {
					t.Error(err)
				}
				return
			}
			release(ctx)
		}()
		go func() {
			defer wg.Done()
			r.ReconcileAll(ctx)
		}()
		go func() {
			defer wg.Done()
			if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil && !errors.Is(err, ErrBusy) {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if r.Held("a") {
		t.Fatal("all the reservations should have been released")
	}
	ins, err := fake.Inspect(ctx, r.ContainerID(ctx, "a"))
	if err != nil || !ins.Running || calls(fake, "Create") != 1 {
		t.Fatalf("ins=%+v err=%v calls=%v", ins, err, fake.Calls)
	}
}

// plan-4: a server that stays reserved unable to start (e.g. without a data
// directory after a failed restore) shows the reason in Observed for as long as the
// reservation lasts: neither a tick nor SyncSpecs (StoreForce clears failures) delete it, and it disappears when
// it is released. Without a reservation, HoldError does nothing.
func TestHoldErrorIsObservedUntilRelease(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	r.HoldError("a", "must not remain")
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("without a reservation HoldError does nothing: %q", obs.Error)
	}
	release, err := r.Hold("a", "no data")
	if err != nil {
		t.Fatal(err)
	}
	const msg = "the data directory is missing"
	r.HoldError("a", msg)
	if obs := r.Observe(ctx, "a"); obs.Error != msg {
		t.Fatalf("Observed.Error = %q, want %q", obs.Error, msg)
	}
	r.ReconcileAll(ctx)
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: runningState, SpecJson: []byte(specJSON3G)}); err != nil {
		t.Fatal(err)
	}
	if obs := r.Observe(ctx, "a"); obs.Error != msg {
		t.Fatalf("after a tick and SyncSpecs Observed.Error = %q, want %q", obs.Error, msg)
	}
	release(ctx)
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("on release it disappears: %q", obs.Error)
	}
	again, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	defer again(ctx)
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("a new reservation does not inherit the error: %q", obs.Error)
	}
}

// listFailEngine makes ListManaged fail while fail is active.
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
		return nil, errors.New("docker is not responding")
	}
	return e.Fake.ListManaged(ctx)
}

// plan-4: Container distinguishes "there is no container" (nil, nil) from "could not be checked"
// (error): a backup or a restore cannot mistake the latter for the former.
func TestContainerReportsDockerErrors(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	eng := &listFailEngine{Fake: fake}
	r.eng = eng
	ctx := context.Background()
	if c, err := r.Container(ctx, "a"); c != nil || err != nil {
		t.Fatalf("without a container: %+v, %v", c, err)
	}
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	c, err := r.Container(ctx, "a")
	if err != nil || c == nil || c.ID != r.ContainerID(ctx, "a") || c.State != "running" {
		t.Fatalf("Container = %+v, %v", c, err)
	}
	eng.setFail(true)
	if c, err := r.Container(ctx, "a"); c != nil || err == nil || !strings.Contains(err.Error(), "docker is not responding") {
		t.Fatalf("with Docker failing: %+v, %v", c, err)
	}
}

// ErrBusy has a neutral prefix and each place adds the specific reason: a server
// locked without data does not say "busy with another backup or restore".
func TestBusyMessageNamesTheReason(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	release, err := r.Hold("a", "no data directory")
	if err != nil {
		t.Fatal(err)
	}
	defer release(ctx)
	want := "server busy or reserved (no data directory)"
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err == nil || err.Error() != want {
		t.Fatalf("Power = %v; want %q", err, want)
	}
	if err := r.Remove(ctx, "a", false); err == nil || err.Error() != want {
		t.Fatalf("Remove = %v; want %q", err, want)
	}
	if _, err := r.Hold("a", "backup"); err == nil || err.Error() != want {
		t.Fatalf("Hold = %v; want %q", err, want)
	}
}

// TryHold does not wait for the server's lock (a long reconciliation, an image pull): if it is held, busy.
func TestTryHoldDoesNotWaitForTheServerLock(t *testing.T) {
	r, st, _, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	unlock := r.lock("a")
	_, err := r.TryHold("a", "save-on")
	unlock()
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("with the lock held = %v", err)
	}
	release, err := r.TryHold("a", "save-on")
	if err != nil {
		t.Fatal(err)
	}
	if r.HeldReason("a") != "save-on" {
		t.Fatalf("reason = %q", r.HeldReason("a"))
	}
	if _, err := r.TryHold("a", "another"); !errors.Is(err, ErrBusy) {
		t.Fatalf("already reserved = %v", err)
	}
	release(context.Background())
	if r.Held("a") {
		t.Fatal("liberado")
	}
}
