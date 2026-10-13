package reconcile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const running = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

func state(t *testing.T, r *Reconciler, id string) string {
	t.Helper()
	c, err := r.Container(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if c == nil {
		return "missing"
	}
	return c.State
}

func TestCrashLoopStopRetainsUntilPowerStart(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	if got := state(t, r, "a"); got != "exited" {
		t.Fatalf("estado tras la parada = %s", got)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "bucle de crash") {
		t.Fatalf("observed = %+v", o)
	}
	starts := calls(fake, "Start ")
	// Ni el tick ni un SyncSpecs con la misma versión y «en marcha» lo arrancan.
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: running, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Start ") != starts || state(t, r, "a") != "exited" {
		t.Fatal("un servidor retenido no se arranca")
	}
	if o := rec.get("a"); !strings.Contains(o.Error, "bucle de crash") {
		t.Fatalf("el error sigue visible: %+v", o)
	}
	if msg := r.StartBlocked("a"); !strings.Contains(msg, "bucle de crash") {
		t.Fatalf("StartBlocked = %q", msg)
	}
	// Arrancar a mano levanta la retención.
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if state(t, r, "a") != "running" {
		t.Fatal("Power start lo arranca")
	}
	if l, _ := st.CrashLatch("a"); l != nil {
		t.Fatal("la retención desaparece")
	}
	if msg := r.StartBlocked("a"); msg != "" {
		t.Fatalf("StartBlocked = %q", msg)
	}
}

func TestCrashLatchIgnoredForNewSpecVersion(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	// Una configuración nueva (p. ej. más memoria) se prueba: la retención era de la versión 1.
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: running, SpecJson: []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))}); err != nil {
		t.Fatal(err)
	}
	if state(t, r, "a") != "running" {
		t.Fatal("con una versión nueva se arranca")
	}
	if l, _ := st.CrashLatch("a"); l != nil {
		t.Fatal("la retención de otra versión se borra")
	}
}

func TestCrashLoopStopBusyWhenHeld(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "copia")
	if err != nil {
		t.Fatal(err)
	}
	defer release(ctx)
	if err := r.CrashLoopStop(ctx, "a", 4); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
	if msg := r.StartBlocked("a"); !strings.Contains(msg, "copia") {
		t.Fatalf("StartBlocked con reserva = %q", msg)
	}
	if msg := r.StartBlocked("desconocido"); msg == "" {
		t.Fatal("un servidor que el agente no conoce no se arranca")
	}
}

type sinkRec struct {
	mu    sync.Mutex
	kinds []string
}

func (s *sinkRec) fn(_, kind, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kinds = append(s.kinds, kind)
}

func (s *sinkRec) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.kinds...)
}

func TestDriftEventOnlyForTheAppliedVersion(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	sink := &sinkRec{}
	r.SetEventSink(sink.fn)
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	// Una versión nueva recrea sin drift.
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: running, SpecJson: []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))}); err != nil {
		t.Fatal(err)
	}
	if got := sink.list(); len(got) != 0 {
		t.Fatalf("eventos = %v", got)
	}
	// Alguien cambia el contenedor fuera del agente: misma versión aplicada, hash distinto.
	for _, c := range fake.Containers {
		c.Config.Labels[spec.LabelHash] = "cambiado-a-mano"
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got := sink.list(); len(got) != 1 || got[0] != KindDrift {
		t.Fatalf("eventos = %v", got)
	}
}

func TestCrashLoopMessage(t *testing.T) {
	if msg := CrashLoopMessage(5); !strings.Contains(msg, "5 veces") || !strings.Contains(msg, "Arrancar") {
		t.Fatalf("msg = %q", msg)
	}
}

// Un servidor bajo demanda retenido que vuelve a estar en marcha (la política de reinicio en la ventana entre la
// retención y la parada, o restartPolicy always tras reiniciar el daemon) se para en el tick: mc-router no lo
// arrancaría (la política del proxy lo impide), pero Docker sí.
func TestOnDemandLatchedServerIsStoppedByTheTick(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() })
	put(t, st, "a", "alpha", 1, running, routedJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	c, err := r.Container(ctx, "a")
	if err != nil || c == nil || c.State != "exited" {
		t.Fatalf("tras la retención: %+v %v", c, err)
	}
	if err := fake.Start(ctx, c.ID); err != nil { // Docker lo vuelve a arrancar por su cuenta
		t.Fatal(err)
	}
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got := state(t, r, "a"); got != "exited" {
		t.Fatalf("un bajo demanda retenido en marcha se para; estado = %s", got)
	}
}

func TestCrashLoopStopUnlessStartedYieldsToPower(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	gen := r.StartGen("a")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART); err != nil {
		t.Fatal(err)
	}
	if stopped, err := r.CrashLoopStopUnlessStarted(ctx, "a", 4, gen); err != nil || stopped {
		t.Fatalf("decidida antes del reinicio: stopped=%v err=%v", stopped, err)
	}
	if l, _ := st.CrashLatch("a"); l != nil || state(t, r, "a") != "running" {
		t.Fatal("no retiene ni para")
	}
	if stopped, err := r.CrashLoopStopUnlessStarted(ctx, "a", 4, r.StartGen("a")); err != nil || !stopped {
		t.Fatalf("decidida después: stopped=%v err=%v", stopped, err)
	}
	if l, _ := st.CrashLatch("a"); l == nil || state(t, r, "a") != "exited" {
		t.Fatal("retiene y para")
	}
}
