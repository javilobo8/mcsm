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
		r.markFailure("a")
		if got := r.retryAt["a"].Sub(r.now()); got != w {
			t.Fatalf("fallo %d: backoff = %v, want %v", i+1, got, w)
		}
	}
	for i := 0; i < 100; i++ {
		r.markFailure("a")
	}
	if got := r.retryAt["a"].Sub(r.now()); got != 5*time.Minute {
		t.Fatalf("backoff = %v, want 5m", got)
	}
}
