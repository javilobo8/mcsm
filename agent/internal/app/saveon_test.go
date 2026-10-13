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
	e.a.bk.retrySaveOn(context.Background()) // sigue fallando
	if ids, _ := e.st.SaveOnPending(); len(ids) != 1 {
		t.Fatalf("pendientes = %v", ids)
	}
	fail.Store(false)
	e.a.bk.retrySaveOn(context.Background())
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
	e.a.bk.retrySaveOn(context.Background())
	if len(e.rc.list()) != before {
		t.Fatal("con el servidor reservado no se toca RCON")
	}
	release(context.Background())
	if r := e.handle(3, &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}); r.GetAck() == nil {
		t.Fatalf("stop: %+v", r)
	}
	before = len(e.rc.list())
	e.a.bk.retrySaveOn(context.Background())
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
	e.a.bk.retrySaveOn(context.Background())
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
