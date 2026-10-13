package app

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/jobs"
	"mcsm/agent/internal/reconcile"
)

// failingSaveOn hace que save-on falle mientras fail esté a true; el resto va al RCON falso del entorno.
func failingSaveOn(e *backupEnv, fail *atomic.Bool) {
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" && fail.Load() {
			return "", errors.New("rcon caído")
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
}

// eventKinds entrega lo que haya en la cola de eventos y devuelve los kinds recibidos.
func eventKinds(t *testing.T, e *backupEnv) []string {
	t.Helper()
	mark := make(chan struct{})
	e.a.events.ch <- outItem{mark: mark}
	select {
	case <-mark:
	case <-time.After(3 * time.Second):
		t.Fatal("la cola de eventos no avanza")
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
		t.Fatalf("la copia con save-on fallido falla: %+v", f)
	}
	if ids, _ := e.st.SaveOnPending(); !slices.Equal(ids, []string{"a"}) {
		t.Fatalf("pendientes = %v", ids)
	}
	retrySettle(t, e) // sigue fallando
	if ids, _ := e.st.SaveOnPending(); len(ids) != 1 {
		t.Fatalf("pendientes = %v", ids)
	}
	fail.Store(false)
	e.clk.Advance(saveOnBackoffMin) // tras el primer fallo, la espera mínima
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pendientes = %v", ids)
	}
	if got := eventKinds(t, e); !slices.Equal(got, []string{KindSaveOnPending, KindSaveOnResumed}) {
		t.Fatalf("eventos = %v", got)
	}
}

func TestSaveOnPendingForgottenWhenStoppedAndSkippedWhenHeld(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	release, err := e.a.rec.Hold("a", "copia")
	if err != nil {
		t.Fatal(err)
	}
	before := len(e.rc.list())
	retrySettle(t, e)
	if len(e.rc.list()) != before {
		t.Fatal("con el servidor reservado no se toca RCON")
	}
	release(context.Background())
	if r := e.handle(3, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop: %+v", r)
	}
	before = len(e.rc.list())
	retrySettle(t, e) // reservado no cuenta como fallo: no hay espera
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("parado: se olvida; pendientes = %v", ids)
	}
	if len(e.rc.list()) != before {
		t.Fatal("parado no se envía save-on")
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
		t.Fatalf("pendientes = %v", ids)
	}
}

// Una copia en caliente que arranca mientras retrySaveOn envía save-on no puede colarse: el servidor está
// reservado durante el RCON (si no, el save-on reactivaría el guardado a mitad de su tar).
func TestRetrySaveOnReservesTheServerDuringTheRcon(t *testing.T) {
	e := newBackupEnv(t, backupsSpecJSON)
	if err := e.st.MarkSaveOnPending("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	var sent atomic.Bool
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			sent.Store(true)
			release, err := e.a.rec.Hold("a", holdBackup) // la copia llega justo ahora
			if err == nil {
				release(context.Background())
				t.Error("una copia pudo reservar el servidor a mitad del save-on")
			} else if !errors.Is(err, reconcile.ErrBusy) {
				t.Errorf("err = %v", err)
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	retrySettle(t, e)
	if !sent.Load() {
		t.Fatal("no se envió save-on")
	}
	if e.a.rec.Held("a") {
		t.Fatal("la reserva del save-on se libera al terminar")
	}
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pendientes = %v", ids)
	}
}

// retrySettle lanza una pasada de reintentos de save-on y espera a que terminen.
func retrySettle(t *testing.T, e *backupEnv) {
	t.Helper()
	e.a.bk.retrySaveOn(context.Background())
	e.settle(t)
}

// saveOnCounter hace que save-on falle mientras fail esté a true y cuenta los intentos.
func saveOnCounter(e *backupEnv, fail *atomic.Bool) *atomic.Int32 {
	var n atomic.Int32
	e.a.rcon = func(ctx context.Context, host string, port uint16, pass, cmd string) (string, error) {
		if cmd == "save-on" {
			n.Add(1)
			if fail.Load() {
				return "", errors.New("rcon caído")
			}
		}
		return e.rc.fn(ctx, host, port, pass, cmd)
	}
	return &n
}

// S3: tras cada fallo, el servidor espera 30 s, 60 s, 120 s… hasta 5 min; el éxito reinicia la espera.
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
			t.Fatalf("intento %d: save-on enviado %d veces", i+1, got)
		}
		e.clk.Advance(wait - time.Second)
		retrySettle(t, e)
		if got := n.Load(); got != int32(i+1) {
			t.Fatalf("intento %d: antes de %v no se reintenta (%d)", i+1, wait, got)
		}
		e.clk.Advance(time.Second)
	}
	fail.Store(false)
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pendientes = %v", ids)
	}
	// Un fallo nuevo tras el éxito se reintenta enseguida: la espera empezó de cero.
	before := n.Load()
	if err := e.st.MarkSaveOnPending("a", time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	retrySettle(t, e)
	if n.Load() != before+1 {
		t.Fatal("tras un éxito la espera se reinicia")
	}
}

// S3: parar el servidor olvida el pendiente y su espera.
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
		t.Fatalf("intentos = %d", n.Load())
	}
	if r := e.handle(3, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop: %+v", r)
	}
	e.clk.Advance(saveOnBackoffMin)
	retrySettle(t, e)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("parado: pendientes = %v", ids)
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
		t.Fatal("tras pararlo, la espera empieza de cero")
	}
}

// S3: el RCON del reintento tiene un plazo corto (el servidor queda reservado mientras dura).
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
		t.Fatalf("plazo del RCON = %v (con plazo %v), máximo %v", left, hasDeadline, saveOnRetryTimeout)
	}
}

// S3: cada reintento va en su goroutine (la pasada no espera al RCON) y nunca dos del mismo servidor a la vez.
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
		t.Fatal("la pasada espera al RCON")
	}
	select {
	case <-entered:
	case <-time.After(hangGuard):
		t.Fatal("el reintento no empezó")
	}
	e.a.bk.retrySaveOn(context.Background()) // el anterior sigue en curso: no se solapa
	e.a.bk.retrySaveOn(context.Background())
	if got := n.Load(); got != 1 {
		t.Fatalf("save-on en curso a la vez = %d", got)
	}
	close(unblock)
	e.settle(t)
	if ids, _ := e.st.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pendientes = %v", ids)
	}
}

const hangGuard = 10 * time.Second // solo evita colgar la suite
