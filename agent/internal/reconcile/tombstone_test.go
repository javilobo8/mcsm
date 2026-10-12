package reconcile

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// flakyRemove envuelve el fake de Docker para que Remove falle mientras err no sea nil.
type flakyRemove struct {
	*docker.Fake
	mu  sync.Mutex
	err error
}

func (f *flakyRemove) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *flakyRemove) Remove(ctx context.Context, id string) error {
	f.mu.Lock()
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
	if tomb, _ := r.tombstoned("a"); !tomb {
		t.Fatal("la lápida debe sobrevivir a un reintento fallido")
	}
	eng.setErr(nil)
	r.ReconcileAll(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("el tick debe reintentar el borrado: %v", fake.Calls)
	}
	if tomb, _ := r.tombstoned("a"); tomb {
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
	r.ReconcileAll(ctx)
	if containers(t, fake) != 0 {
		t.Fatalf("tras liberar, el tick borra el contenedor: %v", fake.Calls)
	}
}

// Un StoreForce que llega mientras el tick reintenta un borrado nunca pierde la spec: el
// reintento vuelve a comprobar la lápida bajo el lock del servidor.
func TestRetryRemovalsNeverDeletesARevivedSpec(t *testing.T) {
	for i := 0; i < 30; i++ {
		r, st, _, eng := setupFlaky(t)
		ctx := context.Background()
		put(t, st, "a", "alpha", 1, runningState, specJSON)
		if err := r.Reconcile(ctx, "a"); err != nil {
			t.Fatal(err)
		}
		forgetWithFailedRemove(t, r, eng, "a")
		eng.setErr(nil)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); r.ReconcileAll(ctx) }()
		go func() {
			defer wg.Done()
			if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: runningState, SpecJson: []byte(specJSON)}); err != nil {
				t.Error(err)
			}
		}()
		wg.Wait()
		if sp, _ := st.GetSpec("a"); sp == nil || sp.Version != 3 {
			t.Fatalf("iteración %d: el reintento borró una spec revivida: %+v", i, sp)
		}
		if tomb, _ := r.tombstoned("a"); tomb {
			t.Fatalf("iteración %d: con spec no hay lápida", i)
		}
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
