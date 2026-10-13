package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"

	"github.com/moby/moby/api/types/container"
)

// flakyRemove wraps the Docker fake so that Remove fails while err is not nil.
type flakyRemove struct {
	*docker.Fake
	mu       sync.Mutex
	err      error
	attempts int // calls to Remove, failed or not
}

func (f *flakyRemove) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *flakyRemove) Remove(ctx context.Context, id string) error {
	f.mu.Lock()
	f.attempts++
	err := f.err
	f.mu.Unlock()
	if err != nil {
		return err
	}
	return f.Fake.Remove(ctx, id)
}

// setupFlaky is setup with a Docker whose Remove can fail.
func setupFlaky(t *testing.T) (*Reconciler, *store.Store, *docker.Fake, *flakyRemove) {
	t.Helper()
	r, st, fake, _, _ := setup(t)
	eng := &flakyRemove{Fake: fake}
	r.eng = eng
	return r, st, fake, eng
}

func containers(t *testing.T, fake *docker.Fake) int {
	t.Helper()
	list, err := fake.ListManaged(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return len(list)
}

// forgetWithFailedRemove reproduces SyncSpecs with removed_ids: Forget and, in the background,
// a Remove whose container deletion fails.
func forgetWithFailedRemove(t *testing.T, r *Reconciler, eng *flakyRemove, id string) {
	t.Helper()
	if err := r.Forget(id); err != nil {
		t.Fatal(err)
	}
	eng.setErr(errors.New("docker: could not delete"))
	if err := r.Remove(context.Background(), id, false); err == nil {
		t.Fatal("expected the container deletion to fail")
	}
}

func TestForgetThenFailedRemoveIsRetriedByTick(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	if containers(t, fake) != 1 {
		t.Fatal("the container is still there after the failure")
	}
	r.ReconcileAll(ctx) // Docker keeps failing: the tombstone is kept
	if containers(t, fake) != 1 {
		t.Fatal("it cannot be deleted while Docker fails")
	}
	if tomb, _ := st.HasTombstone("a"); !tomb {
		t.Fatal("the tombstone must survive a failed retry")
	}
	eng.setErr(nil)
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) } // the backoff expires (30 s)
	r.ReconcileAll(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("the tick must retry the deletion: %v", fake.Calls)
	}
	if tomb, _ := st.HasTombstone("a"); tomb {
		t.Fatal("the tombstone is deleted when the removal succeeds")
	}
	if calls(fake, "Create") != 1 {
		t.Fatalf("it must not resurrect: %v", fake.Calls)
	}
}

func TestTombstoneIsNotADesiredServer(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	r.ReconcileAll(ctx)
	if specs, _ := st.ListSpecs(); len(specs) != 0 {
		t.Fatalf("a tombstone is not a spec (inventory, ticks): %v", specs)
	}
	if vers, _ := st.SpecVersions(); len(vers) != 0 {
		t.Fatalf("a tombstone does not go in the Hello: %v", vers)
	}
	if list, _ := st.ListTombstones(); len(list) != 1 || list[0].ServerID != "a" {
		t.Fatalf("Forget leaves an explicit tombstone: %+v", list)
	}
	if calls(fake, "Start") != 0 || calls(fake, "Create") != 1 {
		t.Fatalf("a tombstone is not reconciled: %v", fake.Calls)
	}
	if obs := r.Observe(ctx, "a"); obs.AppliedVersion != 0 {
		t.Fatalf("the tombstone must not leak as an applied version: %d", obs.AppliedVersion)
	}
}

// The tombstone is in the bbolt store: it survives an agent restart.
func TestTombstoneSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	fake := docker.NewFake()
	eng := &flakyRemove{Fake: fake}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := New(st, eng, t.TempDir(), "mcsm", stubStatus, nil)
	r.log = quiet
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st2, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st2.Close() })
	eng.setErr(nil)
	r2 := New(st2, eng, t.TempDir(), "mcsm", stubStatus, nil)
	r2.log = quiet
	r2.ReconcileAll(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("after restarting, the tick must retry the deletion: %v", fake.Calls)
	}
}

func TestRetryRemovalsReportsCompletedIDs(t *testing.T) {
	r, st, _, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	put(t, st, "b", "beta", 1, runningState, strings.Replace(specJSON, `"game":25565`, `"game":25566`, 1))
	for _, id := range []string{"a", "b"} {
		if err := r.Reconcile(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	forgetWithFailedRemove(t, r, eng, "a")
	if got := r.RetryRemovals(ctx); len(got) != 0 {
		t.Fatalf("with Docker failing none finishes: %v", got)
	}
	eng.setErr(nil)
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) } // the backoff expires (30 s)
	if got := r.RetryRemovals(ctx); len(got) != 1 || got[0] != "a" {
		t.Fatalf("RetryRemovals = %v, want [a]", got)
	}
	if got := r.RetryRemovals(ctx); len(got) != 0 {
		t.Fatalf("without tombstones there is nothing to retry: %v", got)
	}
	if r.ContainerID(ctx, "b") == "" {
		t.Fatal("it does not touch servers with a spec")
	}
}

func TestApplyCancelsTombstone(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	eng.setErr(nil)
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: runningState, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("Apply voids the tombstone: the server stays alive: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("Apply must delete the tombstone")
	}
}

func TestStoreForceCancelsTombstone(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	eng.setErr(nil)
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: runningState, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	if obs := r.Observe(ctx, "a"); obs.AppliedVersion != 0 {
		t.Fatalf("after voiding the tombstone no applied version remains: %d", obs.AppliedVersion)
	}
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("StoreForce voids the tombstone: the server stays alive: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d, want 1", v)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("StoreForce must delete the tombstone")
	}
}

// A server withdrawn during a backup (Hold) is not deleted until the reservation is released, and
// afterwards the tick finishes the job.
func TestTombstoneWaitsForHold(t *testing.T) {
	r, st, fake, _ := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Forget("a"); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", false); !errors.Is(err, ErrBusy) {
		t.Fatalf("Remove = %v, want ErrBusy", err)
	}
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 {
		t.Fatal("it is not deleted during the reservation")
	}
	release(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("on release the pending deletion is completed: %v", fake.Calls)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("the tombstone is deleted when the deletion completes")
	}
	if calls(fake, "Create") != 1 || calls(fake, "Start") != 1 {
		t.Fatalf("releasing does not resurrect the withdrawn server: %v", fake.Calls)
	}
}

// A StoreForce that arrives between the tombstone listing and the retry never loses the spec:
// the retry checks the tombstone again under the server's lock.
func TestRetryRemovalsNeverDeletesARevivedSpec(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	eng.setErr(nil)
	list, err := st.ListTombstones() // what RetryRemovals would have listed
	if err != nil || len(list) != 1 {
		t.Fatalf("ListTombstones = %v, %v", list, err)
	}
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: runningState, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	tried, err := r.retryRemoval(ctx, list[0].ServerID)
	if err != nil || tried {
		t.Fatalf("retryRemoval = %v, %v: the tombstone no longer exists", tried, err)
	}
	if sp, _ := st.GetSpec("a"); sp == nil || sp.Version != 3 {
		t.Fatalf("the retry deleted a revived spec: %+v", sp)
	}
	if containers(t, fake) != 1 {
		t.Fatal("the revived server's container is still there")
	}
}

// A complete Remove (the panel's RemoveServer) leaves no tombstone: if the container
// deletion fails, the panel keeps the server and is the one that retries.
func TestRemoveServerFailureLeavesNoTombstone(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	eng.setErr(errors.New("docker: could not delete"))
	if err := r.Remove(ctx, "a", false); err == nil {
		t.Fatal("expected an error")
	}
	eng.setErr(nil)
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 {
		t.Fatal("without a tombstone, the tick does not delete containers on its own initiative")
	}
	if err := r.Remove(ctx, "a", false); err != nil || containers(t, fake) != 0 {
		t.Fatalf("the panel's retry does delete it: err=%v", err)
	}
}

// managedContainer creates an mcsm.* container foreign to any spec in the store.
func managedContainer(t *testing.T, fake *docker.Fake, id string) {
	t.Helper()
	cfg := &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": id, "mcsm.slug": id}}
	if _, err := fake.Create(context.Background(), "mcsm-"+id, cfg, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
}

// RetryRemovals only deletes containers with an explicit tombstone. An mcsm.* container with neither a spec
// nor a tombstone is not touched, whatever its applied version is (the previous version's
// sentinel no longer means anything).
func TestRetryRemovalsOnlyTouchesTombstonedContainers(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	managedContainer(t, fake, "ghost")
	managedContainer(t, fake, "legacy")
	if err := st.SetApplied("legacy", math.MaxUint64); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	eng.setErr(nil)
	got := r.RetryRemovals(ctx)
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("RetryRemovals = %v, want [a]", got)
	}
	list, _ := fake.ListManaged(ctx)
	if len(list) != 2 {
		t.Fatalf("containers without a tombstone remain: %+v", list)
	}
	for _, c := range list {
		if id := c.Labels["mcsm.server_id"]; id != "ghost" && id != "legacy" {
			t.Fatalf("unexpected container: %s", id)
		}
	}
}

// A tombstone whose container no longer exists is cleaned up without touching Docker.
func TestRetryRemovalsDropsTombstoneWithoutContainer(t *testing.T) {
	r, st, fake, _ := setupFlaky(t)
	ctx := context.Background()
	if err := st.ForgetWithTombstone("gone", time.UnixMilli(1)); err != nil {
		t.Fatal(err)
	}
	got := r.RetryRemovals(ctx)
	if len(got) != 1 || got[0] != "gone" {
		t.Fatalf("RetryRemovals = %v, want [gone]", got)
	}
	if has, _ := st.HasTombstone("gone"); has {
		t.Fatal("the tombstone without a container must be deleted")
	}
	if calls(fake, "Remove") != 0 || calls(fake, "Stop") != 0 {
		t.Fatalf("there is nothing to delete in Docker: %v", fake.Calls)
	}
}

func (f *flakyRemove) removeAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

// A tombstone deletion that fails is retried with backoff (spec §6.2: 30 s, 60 s, … max.
// 5 min), not on every tick.
func TestRetryRemovalsBacksOff(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	base := eng.removeAttempts()
	now := time.Unix(1_000_000, 0)
	r.now = func() time.Time { return now }
	step := func(advance time.Duration, want int, msg string) {
		t.Helper()
		now = now.Add(advance)
		r.RetryRemovals(ctx)
		if got := eng.removeAttempts() - base; got != want {
			t.Fatalf("%s: attempts = %d, want %d", msg, got, want)
		}
	}
	step(0, 1, "first retry")
	step(0, 1, "within the backoff it does not retry")
	step(29*time.Second, 1, "at 29 s neither")
	step(2*time.Second, 2, "at 31 s it retries")
	step(31*time.Second, 2, "the backoff grows (60 s)")
	step(30*time.Second, 3, "at 61 s it retries")
	eng.setErr(nil)
	step(2*time.Minute, 4, "after the backoff, deletion succeeds")
	if containers(t, fake) != 0 {
		t.Fatal("the container must be deleted")
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("the tombstone is deleted")
	}
	if _, waiting := r.retryAt["a"]; waiting {
		t.Fatal("success clears the backoff")
	}
}

// Each pass attempts at most maxRemovalsPerTick deletions: N stuck containers do not
// block the tick N×60 s. Those that fail stay in backoff and make room for the rest.
func TestRetryRemovalsLimitsWorkPerTick(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	const n = maxRemovalsPerTick + 2
	for i := 0; i < n; i++ {
		id := string(rune('a' + i))
		managedContainer(t, fake, id)
		if err := st.ForgetWithTombstone(id, time.UnixMilli(1)); err != nil {
			t.Fatal(err)
		}
	}
	eng.setErr(errors.New("docker: could not delete"))
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != maxRemovalsPerTick {
		t.Fatalf("first pass: attempts = %d, want %d", got, maxRemovalsPerTick)
	}
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != n {
		t.Fatalf("second pass: attempts = %d, want %d (the others, in backoff, do not count)", got, n)
	}
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != n {
		t.Fatalf("all in backoff: attempts = %d, want %d", got, n)
	}
}
