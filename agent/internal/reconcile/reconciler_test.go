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
		t.Fatal("debe crear el directorio de datos")
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
		t.Fatal("no debe arrancar un servidor deseado parado")
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
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON) // misma spec, otra versión
	_ = r.Reconcile(context.Background(), "a")
	if calls(fake, "Create") != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("no debería recrear; calls tras la 1ª: %v", fake.Calls[before:])
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
	if !strings.Contains(joined, "Stop fake0001 1m0s;Remove fake0001;EnsureImage itzg/minecraft-server:java21;Create mcsm-alpha;Start fake0002") {
		t.Fatalf("secuencia inesperada: %v", fake.Calls)
	}
}

func TestStartWhenStoppedButDesiredRunning(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(context.Background(), "a")
	id := r.ContainerID(context.Background(), "a")
	_ = fake.Stop(context.Background(), id, time.Second) // alguien lo paró a mano
	_ = r.Reconcile(context.Background(), "a")
	ins, _ := fake.Inspect(context.Background(), id)
	if !ins.Running {
		t.Fatal("debe volver a arrancarlo")
	}
}

func TestErrorIsObservedAndRetriedWithBackoff(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	fake.CreateErr = errors.New("driver failed programming external connectivity: port is already allocated")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(context.Background(), "a"); err == nil {
		t.Fatal("esperaba error")
	}
	if !strings.Contains(rec.get("a").Error, "already allocated") || rec.get("a").State != "missing" {
		t.Fatalf("obs = %+v", rec.get("a"))
	}
	n := calls(fake, "Create")
	r.ReconcileAll(context.Background()) // dentro del backoff: no reintenta
	if calls(fake, "Create") != n {
		t.Fatal("no debe reintentar antes de retryAt")
	}
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	fake.CreateErr = nil
	r.ReconcileAll(context.Background())
	if calls(fake, "Create") != n+1 || rec.get("a").Error != "" || rec.get("a").State != "running" {
		t.Fatalf("tras el backoff debe reintentar y limpiar el error: %+v calls=%v", rec.get("a"), fake.Calls)
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
		t.Fatal("debe borrar el contenedor")
	}
	if _, err := os.Stat(filepath.Join(root, "alpha")); err != nil {
		t.Fatal("sin deleteData el directorio se conserva")
	}
	put(t, st, "b", "beta", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(context.Background(), "b")
	_ = r.Remove(context.Background(), "b", true)
	if _, err := os.Stat(filepath.Join(root, "beta")); !os.IsNotExist(err) {
		t.Fatal("con deleteData el directorio se borra")
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
		t.Fatal("STOP debe persistir desired=stopped")
	}
	_ = r.Reconcile(context.Background(), "a") // no debe volver a arrancarlo
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
		t.Fatal("esperaba error")
	}
	obs := rec.get("a")
	if obs.State != "created" || !strings.Contains(obs.Error, "already allocated") {
		t.Fatalf("obs = %+v", obs)
	}
	if v, _ := st.Applied("a"); v != 0 {
		t.Fatalf("no debe marcar la versión como aplicada, applied = %d", v)
	}
	fake.StartErr = nil
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	r.ReconcileAll(context.Background())
	if rec.get("a").State != "running" || rec.get("a").Error != "" || calls(fake, "Create") != 1 {
		t.Fatalf("obs = %+v calls=%v", rec.get("a"), fake.Calls)
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	r, _, _, _, _ := setup(t)
	want := []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second, 240 * time.Second, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		r.markFailure("a", 1, "x")
		if got := r.retryAt["a"].Sub(r.now()); got != w {
			t.Fatalf("fallo %d: backoff = %v, want %v", i+1, got, w)
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
		t.Fatalf("Observe debe conservar el error: %+v", obs)
	}
	if !strings.Contains(rec.get("a").Error, "already allocated") {
		t.Fatal("el observer también debe verlo")
	}
	fake.StartErr = nil
	if err := r.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if obs := r.Observe(context.Background(), "a"); obs.Error != "" {
		t.Fatalf("error debe limpiarse tras éxito: %+v", obs)
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
		t.Fatalf("spec vieja no debe recrear: %v", fake.Calls)
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
		t.Fatalf("versión final = %d, want %d", sp.Version, n+1)
	}
	// Power llegado después se respeta.
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
		t.Fatal("Remove debe borrar la spec")
	}
	r.ReconcileAll(ctx)
	_ = r.Reconcile(ctx, "a")
	if list, _ := fake.ListManaged(ctx); len(list) != 0 || calls(fake, "Create") != 1 {
		t.Fatalf("no debe resucitar: %v", fake.Calls)
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
		t.Fatalf("contenedor huérfano: %+v", list)
	}
}

func TestRemoveRejectsUnsafeSlug(t *testing.T) {
	for _, slug := range []string{".", "..", "", "a/../.."} {
		r, st, _, _, root := setup(t)
		if err := os.MkdirAll(filepath.Join(root, "otro", "data"), 0o755); err != nil {
			t.Fatal(err)
		}
		put(t, st, "a", slug, 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
		if err := r.Remove(context.Background(), "a", true); err == nil {
			t.Fatalf("slug %q: esperaba error", slug)
		}
		if _, err := os.Stat(filepath.Join(root, "otro", "data")); err != nil {
			t.Fatalf("slug %q: no debe borrar datos ajenos", slug)
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
		t.Fatal("en backoff no debe reintentar")
	}
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	r.ReconcileAll(ctx)
	if calls(fake, "Create") != n+1 {
		t.Fatal("una versión nueva debe reintentar de inmediato")
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
		t.Fatalf("no debe tocar contenedores sin spec: %v", fake.Calls)
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
			t.Fatalf("Remove #%d: queda la spec", i+1)
		}
		if list, _ := fake.ListManaged(ctx); len(list) != 0 {
			t.Fatalf("Remove #%d: queda el contenedor", i+1)
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
		t.Fatal("deleteData sobre servidor desconocido debe devolver error, no fallar en silencio")
	}
	if _, err := os.Stat(filepath.Join(root, "alpha", "data")); err != nil {
		t.Fatal("el directorio de datos debe seguir intacto")
	}
}

func TestRemoveInvalidSlugTouchesNothing(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "a")
	put(t, st, "a", "..", 2, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Remove(ctx, "a", true); err == nil {
		t.Fatal("esperaba error")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("no debe borrar la spec")
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("no debe borrar el contenedor: %v", fake.Calls)
	}
}

func TestApplyForceAcceptsOlderSpec(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	mk := func(v uint64) *mcsmv1.ServerSpec {
		return &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
	}
	if err := r.Apply(ctx, mk(5)); err != nil {
		t.Fatal(err)
	}
	if err := r.ApplyForce(ctx, mk(2)); err != nil {
		t.Fatal(err)
	}
	if sp, _ := st.GetSpec("a"); sp.Version != 2 {
		t.Fatalf("version = %d, ApplyForce debe sobreescribir", sp.Version)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d", v)
	}
}
