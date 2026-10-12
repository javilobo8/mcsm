package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
)

// plan-8 (H1): mc-router con autoscale arranca por su cuenta un contenedor parado con hostname, y
// la reserva (Hold) solo frena al agente. Mientras una restauración, un bloqueo sin data o una copia
// en frío tienen el servidor reservado, el contenedor de un servidor bajo demanda no existe: el
// intento de entrar de un jugador (docker start) no tiene nada que arrancar.

// newOnDemandEnv: el servidor "a" con hostname y el router del nodo con autoscale.
func newOnDemandEnv(t *testing.T) *backupEnv {
	t.Helper()
	e := newBackupEnv(t, routedSpecJSON)
	if err := e.a.router.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); err != nil {
		t.Fatal(err)
	}
	return e
}

// wakeAttempt simula a mc-router despertando el contenedor id: debe fallar porque no existe, y
// el servidor no debe tener contenedor.
type wakeAttempt struct {
	mu   sync.Mutex
	errs []string
}

func (w *wakeAttempt) try(e *backupEnv, id string) {
	ctx := context.Background()
	msg := ""
	if err := e.fake.Start(ctx, id); !errors.Is(err, docker.ErrNotFound) {
		msg = fmt.Sprintf("mc-router pudo arrancar %s: %v", id, err)
	} else if c, err := e.a.rec.Container(ctx, "a"); err != nil || c != nil {
		msg = fmt.Sprintf("el servidor tiene contenedor durante la reserva: %+v %v", c, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.errs = append(w.errs, msg)
}

func (w *wakeAttempt) check(t *testing.T) {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.errs) == 0 {
		t.Fatal("no se llegó a simular el intento de entrar")
	}
	for _, m := range w.errs {
		if m != "" {
			t.Fatal(m)
		}
	}
}

func TestRestoreParksOnDemandServer(t *testing.T) {
	for _, asleep := range []bool{false, true} {
		e := newOnDemandEnv(t)
		e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
		e.settle(t)
		name := e.col.created()[0].Filename
		e.writeLevel(t, "LEVEL-2")
		if asleep {
			e.stopContainer(t) // mc-router lo paró por inactividad
		}
		old := e.a.rec.ContainerID(context.Background(), "a")
		var w wakeAttempt
		e.a.bk.restore = func(ctx context.Context, req backup.RestoreRequest) (backup.Meta, error) {
			w.try(e, old) // un jugador intenta entrar a mitad de la restauración
			return backup.Restore(ctx, req)
		}
		e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
		e.settle(t)
		if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK {
			t.Fatalf("final = %+v", fin)
		}
		w.check(t)
		if readLevel(t, e.dataDir()) != "LEVEL-1" {
			t.Fatal("no se restauró la copia")
		}
		c, _ := e.a.rec.Container(context.Background(), "a")
		want := "running"
		if asleep {
			want = "created" // dormido: sigue dormido hasta que entre alguien
		}
		if c == nil || c.ID == old || c.State != want || e.a.rec.Held("a") {
			t.Fatalf("dormido=%v: tras restaurar %+v (se esperaba %s)", asleep, c, want)
		}
	}
}

func TestBlockedOnDemandServerIsParked(t *testing.T) {
	e := newOnDemandEnv(t)
	e.stopContainer(t)
	old := e.a.rec.ContainerID(context.Background(), "a")
	if err := os.Rename(e.dataDir(), e.dataDir()+".aparte"); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulado", backup.ErrDataMissing)
	}
	e.a.bk.recoverAtStart(context.Background())
	if !e.a.rec.Held("a") {
		t.Fatal("debe quedar reservado")
	}
	var w wakeAttempt
	w.try(e, old) // Docker crearía un data vacío y el servidor un mundo nuevo
	w.check(t)
	if _, err := os.Stat(e.dataDir()); !os.IsNotExist(err) {
		t.Fatalf("no debe aparecer un data nuevo: %v", err)
	}
	if err := os.Rename(e.dataDir()+".aparte", e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = backup.RecoverInterrupted
	e.a.bk.checkBlocked()
	e.settle(t)
	waitBackground(t, e.a)
	if c, _ := e.a.rec.Container(context.Background(), "a"); c == nil || c.State != "created" || e.a.rec.Held("a") {
		t.Fatalf("con data de vuelta se recrea, dormido: %+v held=%v", c, e.a.rec.Held("a"))
	}
}

func TestColdBackupParksOnDemandServer(t *testing.T) {
	e := newOnDemandEnv(t)
	e.stopContainer(t)
	old := e.a.rec.ContainerID(context.Background(), "a")
	var w wakeAttempt
	e.a.bk.freeSpace = func(string) (uint64, error) { // durante la copia en frío
		w.try(e, old)
		return 1 << 40, nil
	}
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	w.check(t)
	if c, _ := e.a.rec.Container(context.Background(), "a"); c == nil || c.State != "created" {
		t.Fatalf("tras la copia se recrea, dormido: %+v", c)
	}
}
