package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

const specJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

type recorder struct {
	mu  sync.Mutex
	obs map[string]*mcsmv1.Observed
}

func (r *recorder) fn(id string, o *mcsmv1.Observed) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.obs[id] = o
}

func (r *recorder) get(id string) *mcsmv1.Observed {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.obs[id]
}

func stubStatus(ctx context.Context, host string, port uint16) *mcsmv1.McStatus {
	return &mcsmv1.McStatus{Online: true, PlayersOnline: 2, PlayersMax: 10, Version: "1.21.4"}
}

func setup(t *testing.T) (*Reconciler, *store.Store, *docker.Fake, *recorder, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	rec := &recorder{obs: map[string]*mcsmv1.Observed{}}
	root := filepath.Join(dir, "data")
	r := New(st, fake, root, "mcsm", stubStatus, rec.fn)
	r.now = func() time.Time { return time.Unix(1_000_000, 0) }
	r.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	return r, st, fake, rec, root
}

func put(t *testing.T, st *store.Store, id, slug string, v uint64, desired mcsmv1.DesiredState, js string) {
	t.Helper()
	if err := st.PutSpec(&mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: desired, SpecJson: []byte(js)}); err != nil {
		t.Fatal(err)
	}
}

func calls(f *docker.Fake, prefix string) int {
	n := 0
	for _, c := range f.Calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func TestCreateAndStart(t *testing.T) {
	r, st, fake, rec, root := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha", "data")); err != nil {
		t.Fatal("it must create the data directory")
	}
	if fake.Pulled[0] != "itzg/minecraft-server:java21" {
		t.Fatalf("pulled = %v", fake.Pulled)
	}
	list, _ := fake.ListManaged(context.Background())
	if len(list) != 1 || list[0].Name != "mcsm-alpha" || list[0].State != "running" {
		t.Fatalf("list = %+v", list)
	}
	obs := rec.get("a")
	if obs == nil || obs.State != "running" || obs.AppliedVersion != 1 || obs.Error != "" || !obs.Mc.Online || obs.Mc.PlayersOnline != 2 {
		t.Fatalf("obs = %+v", obs)
	}
}

func TestCreateStopped(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if calls(fake, "Start") != 0 {
		t.Fatal("it must not start a server whose desired state is stopped")
	}
	if rec.get("a").State != "created" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
}

func TestNoopWhenUnchanged(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	before := len(fake.Calls)
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON) // same spec, another version
	_ = r.Reconcile(context.Background(), "a")
	if calls(fake, "Create") != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("it should not recreate; calls after the 1st: %v", fake.Calls[before:])
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
}

func TestRecreateWhenSpecChanges(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	changed := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, changed)
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(fake.Calls, ";")
	first, second := docker.FakeID(1), docker.FakeID(2)
	if !strings.Contains(joined, "Stop "+first+" 1m0s;Remove "+first+";EnsureImage itzg/minecraft-server:java21;Create mcsm-alpha;Start "+second) {
		t.Fatalf("unexpected sequence: %v", fake.Calls)
	}
}

func TestStartWhenStoppedButDesiredRunning(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	id := r.ContainerID(context.Background(), "a")
	_ = fake.Stop(context.Background(), id, time.Second) // someone stopped it by hand
	_ = r.Reconcile(context.Background(), "a")
	ins, _ := fake.Inspect(context.Background(), id)
	if !ins.Running {
		t.Fatal("it must start it again")
	}
}

func TestErrorIsObservedAndRetriedWithBackoff(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	fake.CreateErr = errors.New("driver failed programming external connectivity: port is already allocated")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(rec.get("a").Error, "already allocated") || rec.get("a").State != "missing" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
	n := calls(fake, "Create")
	r.ReconcileAll(context.Background()) // within the backoff: it does not retry
	if calls(fake, "Create") != n {
		t.Fatal("it must not retry before retryAt")
	}
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	fake.CreateErr = nil
	r.ReconcileAll(context.Background())
	if calls(fake, "Create") != n+1 || rec.get("a").Error != "" || rec.get("a").State != "running" {
		t.Fatalf("after the backoff it must retry and clear the error: %+v calls=%v", rec.get("a"), fake.Calls)
	}
}

func TestRemove(t *testing.T) {
	r, st, fake, _, root := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if err := r.Remove(context.Background(), "a", false); err != nil {
		t.Fatal(err)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("it must delete the container")
	}
	if _, err := os.Stat(filepath.Join(root, "alpha")); err != nil {
		t.Fatal("without deleteData the directory is kept")
	}
	put(t, st, "b", "beta", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(context.Background(), "b")
	_ = r.Remove(context.Background(), "b", true)
	if _, err := os.Stat(filepath.Join(root, "beta")); !os.IsNotExist(err) {
		t.Fatal("with deleteData the directory is deleted")
	}
}

func TestPowerUpdatesDesiredState(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if err := r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
	sp, _ := st.GetSpec("a")
	if sp.DesiredState != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatal("STOP must persist desired=stopped")
	}
	_ = r.Reconcile(context.Background(), "a") // it must not start it again
	if rec.get("a").State != "exited" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
	_ = r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART)
	if rec.get("a").State != "running" || calls(fake, "Start") != 2 {
		t.Fatalf("restart: obs=%+v calls=%v", rec.get("a"), fake.Calls)
	}
	_ = r.Power(context.Background(), "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_KILL)
	if rec.get("a").State != "exited" || rec.get("a").ExitCode != 137 {
		t.Fatalf("kill: obs=%+v", rec.get("a"))
	}
}

func TestObserveMissingSpec(t *testing.T) {
	r, _, _, _, _ := setup(t)
	obs := r.Observe(context.Background(), "nope")
	if obs.State != "missing" {
		t.Fatalf("obs = %+v", obs)
	}
}

func TestStartPortConflictIsObservedAndRetried(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	fake.StartErr = errors.New("port is already allocated")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err == nil {
		t.Fatal("expected an error")
	}
	obs := rec.get("a")
	// plan-8: the container that could not start is discarded (Docker 29.7.2 failure) and recreated.
	if obs.State != "missing" || !strings.Contains(obs.Error, "already allocated") {
		t.Fatalf("obs = %+v", obs)
	}
	if v, _ := st.Applied("a"); v != 0 {
		t.Fatalf("it must not mark the version as applied, applied = %d", v)
	}
	fake.StartErr = nil
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	r.ReconcileAll(context.Background())
	if rec.get("a").State != "running" || rec.get("a").Error != "" || calls(fake, "Create") != 2 {
		t.Fatalf("obs = %+v calls=%v", rec.get("a"), fake.Calls)
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	r, _, _, _, _ := setup(t)
	want := []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second, 240 * time.Second, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		r.markFailure("a", 1, "x")
		if got := r.retryAt["a"].Sub(r.now()); got != w {
			t.Fatalf("failure %d: backoff = %v, want %v", i+1, got, w)
		}
	}
	for i := 0; i < 100; i++ {
		r.markFailure("a", 1, "x")
	}
	if got := r.retryAt["a"].Sub(r.now()); got != 5*time.Minute {
		t.Fatalf("backoff = %v, want 5m", got)
	}
}

func TestObserveKeepsLastErrorUntilSuccess(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	fake.StartErr = errors.New("port is already allocated")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	if obs := r.Observe(context.Background(), "a"); !strings.Contains(obs.Error, "already allocated") {
		t.Fatalf("Observe must keep the error: %+v", obs)
	}
	if !strings.Contains(rec.get("a").Error, "already allocated") {
		t.Fatal("the observer must see it too")
	}
	fake.StartErr = nil
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if obs := r.Observe(context.Background(), "a"); obs.Error != "" {
		t.Fatalf("the error must be cleared after success: %+v", obs)
	}
}

func TestApplyIgnoresOlderSpec(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	mk := func(v uint64, js string) *mcsmv1.ServerSpec {
		return &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(js)}
	}
	if err := r.Apply(ctx, mk(5, specJSON)); err != nil {
		t.Fatal(err)
	}
	old := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	if err := r.Apply(ctx, mk(4, old)); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("an old spec must not recreate: %v", fake.Calls)
	}
	if sp, _ := st.GetSpec("a"); sp.Version != 5 {
		t.Fatalf("version = %d", sp.Version)
	}
	if v, _ := st.Applied("a"); v != 5 {
		t.Fatalf("applied = %d", v)
	}
}

func TestApplyAndPowerConcurrent(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	const n = 60
	var wg sync.WaitGroup
	for v := uint64(2); v < n+2; v++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)})
		}()
		go func() {
			defer wg.Done()
			_ = r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP)
		}()
	}
	wg.Wait()
	sp, _ := st.GetSpec("a")
	if sp.Version != n+1 {
		t.Fatalf("final version = %d, want %d", sp.Version, n+1)
	}
	// A Power that arrives later is respected.
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	sp, _ = st.GetSpec("a")
	if sp.Version != n+1 || sp.DesiredState != mcsmv1.DesiredState_DESIRED_STATE_RUNNING {
		t.Fatalf("sp = %+v", sp)
	}
}

func TestRemoveDeletesSpecAndNoResurrection(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("Remove must delete the spec")
	}
	r.ReconcileAll(ctx)
	_ = r.Reconcile(ctx, "a")
	if list, _ := fake.ListManaged(ctx); len(list) != 0 || calls(fake, "Create") != 1 {
		t.Fatalf("it must not resurrect: %v", fake.Calls)
	}
}

func TestRemoveWithConcurrentReconcileAll(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); r.ReconcileAll(ctx) }()
	}
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if list, _ := fake.ListManaged(ctx); len(list) != 0 {
		t.Fatalf("orphan container: %+v", list)
	}
}

func TestRemoveRejectsUnsafeSlug(t *testing.T) {
	for _, slug := range []string{".", "..", "", "a/../.."} {
		r, st, _, _, root := setup(t)
		if err := os.MkdirAll(filepath.Join(root, "other", "data"), 0o755); err != nil {
			t.Fatal(err)
		}
		put(t, st, "a", slug, 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
		if err := r.Remove(context.Background(), "a", true); err == nil {
			t.Fatalf("slug %q: expected an error", slug)
		}
		if _, err := os.Stat(filepath.Join(root, "other", "data")); err != nil {
			t.Fatalf("slug %q: it must not delete foreign data", slug)
		}
	}
}

func TestBackoffResetsWhenSpecVersionChanges(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	fake.CreateErr = errors.New("boom")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	n := calls(fake, "Create")
	r.ReconcileAll(ctx)
	if calls(fake, "Create") != n {
		t.Fatal("in backoff it must not retry")
	}
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	r.ReconcileAll(ctx)
	if calls(fake, "Create") != n+1 {
		t.Fatal("a new version must retry immediately")
	}
}

func TestNeverDeletesUnknownManagedContainer(t *testing.T) {
	r, _, fake, _, _ := setup(t)
	ctx := context.Background()
	cfg := &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "ghost", "mcsm.slug": "ghost"}}
	if _, err := fake.Create(ctx, "mcsm-ghost", cfg, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	r.ReconcileAll(ctx)
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("it must not touch containers without a spec: %v", fake.Calls)
	}
}

func TestRemoveIsIdempotent(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	for i := 0; i < 2; i++ {
		if err := r.Remove(ctx, "a", false); err != nil {
			t.Fatalf("Remove #%d: %v", i+1, err)
		}
		if sp, _ := st.GetSpec("a"); sp != nil {
			t.Fatalf("Remove #%d: the spec remains", i+1)
		}
		if list, _ := fake.ListManaged(ctx); len(list) != 0 {
			t.Fatalf("Remove #%d: the container remains", i+1)
		}
	}
}

func TestRemoveDataOfUnknownServerFails(t *testing.T) {
	r, st, _, _, root := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	if err := r.Remove(ctx, "a", true); err == nil {
		t.Fatal("deleteData on an unknown server must return an error, not fail silently")
	}
	if _, err := os.Stat(filepath.Join(root, "alpha", "data")); err != nil {
		t.Fatal("the data directory must remain intact")
	}
}

func TestRemoveInvalidSlugTouchesNothing(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	put(t, st, "a", "..", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Remove(ctx, "a", true); err == nil {
		t.Fatal("expected an error")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("it must not delete the spec")
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("it must not delete the container: %v", fake.Calls)
	}
}

func TestStoreForceSavesOlderSpecWithoutTouchingDocker(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	mk := func(v uint64, js string) *mcsmv1.ServerSpec {
		return &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(js)}
	}
	if err := r.Apply(ctx, mk(5, specJSON)); err != nil {
		t.Fatal(err)
	}
	r.markFailure("a", 5, "previous failure")
	before := len(fake.Calls)
	old := strings.Replace(specJSON, `"memory":"2G"`, `"memory":"3G"`, 1)
	if err := r.StoreForce(mk(2, old)); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.GetSpec("a"); sp.Version != 2 {
		t.Fatalf("version = %d, StoreForce must overwrite even if it is older", sp.Version)
	}
	if len(fake.Calls) != before {
		t.Fatalf("StoreForce must not touch Docker: %v", fake.Calls[before:])
	}
	if _, waiting := r.retryAt["a"]; waiting || r.lastErr["a"] != "" {
		t.Fatal("StoreForce must clear the backoff so the reconciliation is immediate")
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if v, _ := st.Applied("a"); v != 2 || calls(fake, "Create") != 2 {
		t.Fatalf("applied = %d calls=%v", v, fake.Calls)
	}
}

func TestForgetDeletesSpecButKeepsContainer(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	if err := r.Forget("a"); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("Forget must delete the spec")
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 {
		t.Fatal("Forget does not touch Docker")
	}
	// The specs tick does not see it: it neither recreates, starts nor deletes it.
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Create") != 1 || calls(fake, "Stop") != 0 || calls(fake, "Remove") != 0 {
		t.Fatalf("a forgotten spec is not reconciled: %v", fake.Calls)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 {
		t.Fatal("the container remains until Remove")
	}
	if err := r.Remove(ctx, "a", false); err != nil {
		t.Fatal(err)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 0 || calls(fake, "Remove") != 1 {
		t.Fatalf("Remove after Forget must delete the orphan container: %v", fake.Calls)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("a successful Remove deletes the tombstone")
	}
}

func desired(t *testing.T, st *store.Store, id string) mcsmv1.DesiredState {
	t.Helper()
	sp, err := st.GetSpec(id)
	if err != nil || sp == nil {
		t.Fatalf("spec %s: %v", id, err)
	}
	return sp.DesiredState
}

// If the Docker action fails, the desired state does not change (the panel does not change it
// without an Ack either) and the error stays in Observed until the next successful reconciliation.
func TestPowerFailureKeepsDesiredState(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(ctx, "a")
	fake.StartErr = errors.New("port is already allocated")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err == nil {
		t.Fatal("expected an error")
	}
	if d := desired(t, st, "a"); d != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatalf("desired = %v: a failed START must not persist running", d)
	}
	if obs := r.Observe(ctx, "a"); !strings.Contains(obs.Error, "already allocated") {
		t.Fatalf("the failure must be visible in Observed: %+v", obs)
	}
	fake.StartErr = nil
	n := calls(fake, "Start")
	r.now = func() time.Time { return time.Unix(1_000_000+3600, 0) }
	r.ReconcileAll(ctx) // the tick does not start what the panel believes stopped
	if calls(fake, "Start") != n || rec.get("a").Error != "" {
		t.Fatalf("calls=%v obs=%+v", fake.Calls, rec.get("a"))
	}
}

// Without a container, Power sets the desired state and reconciles (creates and starts or stops).
func TestPowerWithoutContainerReconciles(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if d := desired(t, st, "a"); d != mcsmv1.DesiredState_DESIRED_STATE_RUNNING {
		t.Fatalf("desired = %v", d)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || list[0].State != "running" || rec.get("a").Error != "" {
		t.Fatalf("list=%+v obs=%+v", list, rec.get("a"))
	}
}

func TestPowerWithoutContainerFailureRevertsDesired(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	fake.CreateErr = errors.New("no disk")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err == nil {
		t.Fatal("expected an error")
	}
	if d := desired(t, st, "a"); d != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatalf("desired = %v: the failure must not leave running stored", d)
	}
}
