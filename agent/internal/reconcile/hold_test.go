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
	release, err := r.Hold("a", "copia de seguridad")
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
			t.Fatalf("no debe tocar el contenedor durante la reserva: %v", fake.Calls[before:])
		}
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d, want 1", v)
	}
	if sp, _ := st.GetSpec("a"); sp.Version != 2 {
		t.Fatal("la spec nueva debe quedar guardada")
	}
	release(ctx)
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("tras liberar applied = %d, want 2", v)
	}
	if calls(fake, "Remove") != 1 || calls(fake, "Create") != 2 {
		t.Fatalf("debe recrear al liberar: %v", fake.Calls)
	}
	release(ctx) // idempotente
	if calls(fake, "Create") != 2 {
		t.Fatal("liberar dos veces no repite nada")
	}
}

func TestHoldRejectsSecondHoldPowerAndRemove(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "restauración")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Held("a") || r.Held("b") {
		t.Fatal("Held")
	}
	if _, err := r.Hold("a", "copia"); !errors.Is(err, ErrBusy) || !strings.Contains(err.Error(), "restauración") {
		t.Fatalf("segunda reserva = %v", err)
	}
	stops := calls(fake, "Stop")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); !errors.Is(err, ErrBusy) {
		t.Fatalf("Power = %v", err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("Power no debe tocar el contenedor reservado")
	}
	if err := r.Remove(ctx, "a", false); !errors.Is(err, ErrBusy) {
		t.Fatalf("Remove = %v", err)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("Remove no debe borrar la spec de un servidor reservado")
	}
	release(ctx)
	if r.Held("a") {
		t.Fatal("debe liberarse")
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err != nil {
		t.Fatal(err)
	}
}

func TestHoldWaitsForOperationInProgress(t *testing.T) {
	r, st, _, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	unlock := r.lock("a") // otra operación sobre el servidor en curso
	done := make(chan error, 1)
	go func() {
		_, err := r.Hold("a", "copia")
		done <- err
	}()
	select {
	case <-done:
		t.Fatal("Hold no debe volver mientras otra operación tiene el lock del servidor")
	default:
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Hold no volvió tras liberar el lock")
	}
}

func TestReleaseRestartsServerStoppedDuringHold(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "restauración")
	if err != nil {
		t.Fatal(err)
	}
	cid := r.ContainerID(ctx, "a")
	if err := fake.Stop(ctx, cid, StopTimeout); err != nil { // la restauración lo para
		t.Fatal(err)
	}
	r.ReconcileAll(ctx)
	if ins, _ := fake.Inspect(ctx, cid); ins.Running {
		t.Fatal("durante la reserva nadie debe arrancarlo")
	}
	release(ctx)
	if ins, _ := fake.Inspect(ctx, cid); !ins.Running {
		t.Fatal("al liberar vuelve a su estado deseado (running)")
	}
}

// Una reserva sin motivo sigue siendo una reserva: el motivo vacío no puede desactivar
// las comprobaciones.
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
		t.Fatal("Held con motivo vacío")
	}
	stops := calls(fake, "Stop")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); !errors.Is(err, ErrBusy) {
		t.Fatalf("Power = %v", err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("Power no debe tocar el contenedor reservado")
	}
	release(ctx)
	if r.Held("a") {
		t.Fatal("debe liberarse")
	}
}

// Reservas y liberaciones concurrentes con ticks y acciones de encendido: sin carreras
// (-race), sin bloqueos y con el servidor en su estado deseado al acabar.
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
			release, err := r.Hold("a", "copia")
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
		t.Fatal("todas las reservas debían liberarse")
	}
	ins, err := fake.Inspect(ctx, r.ContainerID(ctx, "a"))
	if err != nil || !ins.Running || calls(fake, "Create") != 1 {
		t.Fatalf("ins=%+v err=%v calls=%v", ins, err, fake.Calls)
	}
}

// plan-4: un servidor que se queda reservado sin poder arrancar (p. ej. sin directorio de
// datos tras una restauración fallida) muestra el motivo en Observed mientras dure la
// reserva: ni un tick ni SyncSpecs (StoreForce limpia los fallos) lo borran, y desaparece al
// liberarla. Sin reserva, HoldError no hace nada.
func TestHoldErrorIsObservedUntilRelease(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	r.HoldError("a", "no debe quedar")
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("sin reserva HoldError no hace nada: %q", obs.Error)
	}
	release, err := r.Hold("a", "sin datos")
	if err != nil {
		t.Fatal(err)
	}
	const msg = "falta el directorio de datos"
	r.HoldError("a", msg)
	if obs := r.Observe(ctx, "a"); obs.Error != msg {
		t.Fatalf("Observed.Error = %q, want %q", obs.Error, msg)
	}
	r.ReconcileAll(ctx)
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: runningState, SpecJson: []byte(specJSON3G)}); err != nil {
		t.Fatal(err)
	}
	if obs := r.Observe(ctx, "a"); obs.Error != msg {
		t.Fatalf("tras un tick y SyncSpecs Observed.Error = %q, want %q", obs.Error, msg)
	}
	release(ctx)
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("al liberar desaparece: %q", obs.Error)
	}
	again, err := r.Hold("a", "copia")
	if err != nil {
		t.Fatal(err)
	}
	defer again(ctx)
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("una reserva nueva no hereda el error: %q", obs.Error)
	}
}

// listFailEngine hace fallar ListManaged mientras fail esté activo.
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
		return nil, errors.New("docker no responde")
	}
	return e.Fake.ListManaged(ctx)
}

// plan-4: Container distingue «no hay contenedor» (nil, nil) de «no se pudo comprobar»
// (error): una copia o una restauración no pueden tomar lo segundo por lo primero.
func TestContainerReportsDockerErrors(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	eng := &listFailEngine{Fake: fake}
	r.eng = eng
	ctx := context.Background()
	if c, err := r.Container(ctx, "a"); c != nil || err != nil {
		t.Fatalf("sin contenedor: %+v, %v", c, err)
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
	if c, err := r.Container(ctx, "a"); c != nil || err == nil || !strings.Contains(err.Error(), "docker no responde") {
		t.Fatalf("con Docker fallando: %+v, %v", c, err)
	}
}

// ErrBusy tiene un prefijo neutro y cada sitio añade el motivo concreto: un servidor
// bloqueado sin datos no dice «ocupado con otra copia o restauración».
func TestBusyMessageNamesTheReason(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	release, err := r.Hold("a", "sin directorio de datos")
	if err != nil {
		t.Fatal(err)
	}
	defer release(ctx)
	want := "servidor ocupado o reservado (sin directorio de datos)"
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP); err == nil || err.Error() != want {
		t.Fatalf("Power = %v; quiero %q", err, want)
	}
	if err := r.Remove(ctx, "a", false); err == nil || err.Error() != want {
		t.Fatalf("Remove = %v; quiero %q", err, want)
	}
	if _, err := r.Hold("a", "copia de seguridad"); err == nil || err.Error() != want {
		t.Fatalf("Hold = %v; quiero %q", err, want)
	}
}

// TryHold no espera al lock del servidor (una reconciliación larga, una descarga de imagen): si está tomado, busy.
func TestTryHoldDoesNotWaitForTheServerLock(t *testing.T) {
	r, st, _, _, _ := setup(t)
	put(t, st, "a", "alpha", 1, runningState, specJSON)
	unlock := r.lock("a")
	_, err := r.TryHold("a", "save-on")
	unlock()
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("con el lock tomado = %v", err)
	}
	release, err := r.TryHold("a", "save-on")
	if err != nil {
		t.Fatal(err)
	}
	if r.HeldReason("a") != "save-on" {
		t.Fatalf("motivo = %q", r.HeldReason("a"))
	}
	if _, err := r.TryHold("a", "otra"); !errors.Is(err, ErrBusy) {
		t.Fatalf("ya reservado = %v", err)
	}
	release(context.Background())
	if r.Held("a") {
		t.Fatal("liberado")
	}
}
