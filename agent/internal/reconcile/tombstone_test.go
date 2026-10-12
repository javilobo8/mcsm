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

// flakyRemove envuelve el fake de Docker para que Remove falle mientras err no sea nil.
type flakyRemove struct {
	*docker.Fake
	mu       sync.Mutex
	err      error
	attempts int // llamadas a Remove, fallidas o no
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

// setupFlaky es setup con un Docker cuyo Remove puede fallar.
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

// forgetWithFailedRemove reproduce SyncSpecs con removed_ids: Forget y, en segundo plano,
// un Remove cuyo borrado del contenedor falla.
func forgetWithFailedRemove(t *testing.T, r *Reconciler, eng *flakyRemove, id string) {
	t.Helper()
	if err := r.Forget(id); err != nil {
		t.Fatal(err)
	}
	eng.setErr(errors.New("docker: no se pudo borrar"))
	if err := r.Remove(context.Background(), id, false); err == nil {
		t.Fatal("esperaba que el borrado del contenedor fallara")
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
		t.Fatal("el contenedor sigue ahí tras el fallo")
	}
	r.ReconcileAll(ctx) // Docker sigue fallando: la lápida se conserva
	if containers(t, fake) != 1 {
		t.Fatal("no puede borrarse mientras Docker falla")
	}
	if tomb, _ := st.HasTombstone("a"); !tomb {
		t.Fatal("la lápida debe sobrevivir a un reintento fallido")
	}
	eng.setErr(nil)
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) } // vence el backoff (30 s)
	r.ReconcileAll(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("el tick debe reintentar el borrado: %v", fake.Calls)
	}
	if tomb, _ := st.HasTombstone("a"); tomb {
		t.Fatal("la lápida se borra cuando la eliminación termina bien")
	}
	if calls(fake, "Create") != 1 {
		t.Fatalf("no debe resucitar: %v", fake.Calls)
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
		t.Fatalf("una lápida no es una spec (inventario, ticks): %v", specs)
	}
	if vers, _ := st.SpecVersions(); len(vers) != 0 {
		t.Fatalf("una lápida no va en el Hello: %v", vers)
	}
	if list, _ := st.ListTombstones(); len(list) != 1 || list[0].ServerID != "a" {
		t.Fatalf("Forget deja una lápida explícita: %+v", list)
	}
	if calls(fake, "Start") != 0 || calls(fake, "Create") != 1 {
		t.Fatalf("una lápida no se reconcilia: %v", fake.Calls)
	}
	if obs := r.Observe(ctx, "a"); obs.AppliedVersion != 0 {
		t.Fatalf("la lápida no debe filtrarse como versión aplicada: %d", obs.AppliedVersion)
	}
}

// La lápida está en el store bbolt: sobrevive a un reinicio del agente.
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
		t.Fatalf("tras reiniciar, el tick debe reintentar el borrado: %v", fake.Calls)
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
		t.Fatalf("con Docker fallando no termina ninguna: %v", got)
	}
	eng.setErr(nil)
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) } // vence el backoff (30 s)
	if got := r.RetryRemovals(ctx); len(got) != 1 || got[0] != "a" {
		t.Fatalf("RetryRemovals = %v, want [a]", got)
	}
	if got := r.RetryRemovals(ctx); len(got) != 0 {
		t.Fatalf("sin lápidas no hay nada que reintentar: %v", got)
	}
	if r.ContainerID(ctx, "b") == "" {
		t.Fatal("no toca servidores con spec")
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
		t.Fatalf("Apply anula la lápida: el servidor sigue vivo: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("Apply debe borrar la lápida")
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
		t.Fatalf("tras anular la lápida no queda versión aplicada: %d", obs.AppliedVersion)
	}
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 || calls(fake, "Remove") != 0 {
		t.Fatalf("StoreForce anula la lápida: el servidor sigue vivo: %v", fake.Calls)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d, want 1", v)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("StoreForce debe borrar la lápida")
	}
}

// Un servidor retirado durante una copia (Hold) no se borra hasta liberar la reserva, y
// después el tick termina el trabajo.
func TestTombstoneWaitsForHold(t *testing.T) {
	r, st, fake, _ := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "copia de seguridad")
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
		t.Fatal("no se borra durante la reserva")
	}
	release(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("al liberar se completa el borrado pendiente: %v", fake.Calls)
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("la lápida se borra al completar el borrado")
	}
	if calls(fake, "Create") != 1 || calls(fake, "Start") != 1 {
		t.Fatalf("liberar no resucita el servidor retirado: %v", fake.Calls)
	}
}

// Un StoreForce que llega entre el listado de lápidas y el reintento nunca pierde la spec:
// el reintento vuelve a comprobar la lápida bajo el lock del servidor.
func TestRetryRemovalsNeverDeletesARevivedSpec(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	forgetWithFailedRemove(t, r, eng, "a")
	eng.setErr(nil)
	list, err := st.ListTombstones() // lo que RetryRemovals habría listado
	if err != nil || len(list) != 1 {
		t.Fatalf("ListTombstones = %v, %v", list, err)
	}
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: runningState, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	tried, err := r.retryRemoval(ctx, list[0].ServerID)
	if err != nil || tried {
		t.Fatalf("retryRemoval = %v, %v: la lápida ya no existe", tried, err)
	}
	if sp, _ := st.GetSpec("a"); sp == nil || sp.Version != 3 {
		t.Fatalf("el reintento borró una spec revivida: %+v", sp)
	}
	if containers(t, fake) != 1 {
		t.Fatal("el contenedor del servidor revivido sigue")
	}
}

// Un Remove completo (RemoveServer del panel) no deja lápida: si el borrado del
// contenedor falla, el panel conserva el servidor y es quien reintenta.
func TestRemoveServerFailureLeavesNoTombstone(t *testing.T) {
	r, st, fake, eng := setupFlaky(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	eng.setErr(errors.New("docker: no se pudo borrar"))
	if err := r.Remove(ctx, "a", false); err == nil {
		t.Fatal("esperaba error")
	}
	eng.setErr(nil)
	r.ReconcileAll(ctx)
	if containers(t, fake) != 1 {
		t.Fatal("sin lápida, el tick no borra contenedores por iniciativa propia")
	}
	if err := r.Remove(ctx, "a", false); err != nil || containers(t, fake) != 0 {
		t.Fatalf("el reintento del panel sí lo borra: err=%v", err)
	}
}

// managedContainer crea un contenedor mcsm.* ajeno a cualquier spec del store.
func managedContainer(t *testing.T, fake *docker.Fake, id string) {
	t.Helper()
	cfg := &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": id, "mcsm.slug": id}}
	if _, err := fake.Create(context.Background(), "mcsm-"+id, cfg, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
}

// RetryRemovals solo borra contenedores con lápida explícita. Un contenedor mcsm.* sin spec
// ni lápida no se toca, aunque su versión aplicada tenga cualquier valor (el centinela de
// la versión anterior ya no significa nada).
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
		t.Fatalf("los contenedores sin lápida siguen: %+v", list)
	}
	for _, c := range list {
		if id := c.Labels["mcsm.server_id"]; id != "ghost" && id != "legacy" {
			t.Fatalf("contenedor inesperado: %s", id)
		}
	}
}

// Una lápida cuyo contenedor ya no existe se limpia sin tocar Docker.
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
		t.Fatal("la lápida sin contenedor debe borrarse")
	}
	if calls(fake, "Remove") != 0 || calls(fake, "Stop") != 0 {
		t.Fatalf("no hay nada que borrar en Docker: %v", fake.Calls)
	}
}

func (f *flakyRemove) removeAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

// Un borrado por lápida que falla se reintenta con backoff (spec §6.2: 30 s, 60 s, … máx.
// 5 min), no en cada tick.
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
			t.Fatalf("%s: intentos = %d, want %d", msg, got, want)
		}
	}
	step(0, 1, "primer reintento")
	step(0, 1, "dentro del backoff no reintenta")
	step(29*time.Second, 1, "a los 29 s tampoco")
	step(2*time.Second, 2, "a los 31 s reintenta")
	step(31*time.Second, 2, "el backoff crece (60 s)")
	step(30*time.Second, 3, "a los 61 s reintenta")
	eng.setErr(nil)
	step(2*time.Minute, 4, "tras el backoff, borrado con éxito")
	if containers(t, fake) != 0 {
		t.Fatal("el contenedor debe borrarse")
	}
	if has, _ := st.HasTombstone("a"); has {
		t.Fatal("la lápida se borra")
	}
	if _, waiting := r.retryAt["a"]; waiting {
		t.Fatal("el éxito limpia el backoff")
	}
}

// Cada pasada intenta como mucho maxRemovalsPerTick borrados: N contenedores atascados no
// bloquean el tick N×60 s. Los que fallan quedan en backoff y dejan sitio al resto.
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
	eng.setErr(errors.New("docker: no se pudo borrar"))
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != maxRemovalsPerTick {
		t.Fatalf("primera pasada: intentos = %d, want %d", got, maxRemovalsPerTick)
	}
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != n {
		t.Fatalf("segunda pasada: intentos = %d, want %d (los demás, en backoff, no cuentan)", got, n)
	}
	r.RetryRemovals(ctx)
	if got := eng.removeAttempts(); got != n {
		t.Fatalf("todos en backoff: intentos = %d, want %d", got, n)
	}
}
