package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
)

// plan-8 (H1): mc-router with autoscale starts on its own a stopped container with a hostname, and
// the reservation (Hold) only holds back the agent. While a restore, a block without data or a cold
// backup have the server reserved, an on-demand server's container does not exist: a
// player's attempt to join (docker start) has nothing to start.

// newOnDemandEnv: server "a" with a hostname and the node's router with autoscale.
func newOnDemandEnv(t *testing.T) *backupEnv {
	t.Helper()
	e := newBackupEnv(t, routedSpecJSON)
	if err := e.a.router.Apply(&mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}); err != nil {
		t.Fatal(err)
	}
	return e
}

// wakeAttempt simulates mc-router waking container id: it must fail because it does not exist, and
// the server must not have a container.
type wakeAttempt struct {
	mu   sync.Mutex
	errs []string
}

func (w *wakeAttempt) try(e *backupEnv, id string) {
	ctx := context.Background()
	msg := ""
	if err := e.fake.Start(ctx, id); !errors.Is(err, docker.ErrNotFound) {
		msg = fmt.Sprintf("mc-router could start %s: %v", id, err)
	} else if c, err := e.a.rec.Container(ctx, "a"); err != nil || c != nil {
		msg = fmt.Sprintf("the server has a container during the reservation: %+v %v", c, err)
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
		t.Fatal("the attempt to join was not simulated")
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
			e.stopContainer(t) // mc-router stopped it for inactivity
		}
		old := e.a.rec.ContainerID(context.Background(), "a")
		var w wakeAttempt
		e.a.bk.restore = func(ctx context.Context, req backup.RestoreRequest) (backup.Meta, error) {
			w.try(e, old) // a player tries to join midway through the restore
			return backup.Restore(ctx, req)
		}
		e.handle(20, &mcsmv1.BackupRestore{ServerId: "a", Filename: name, JobId: "job-r"})
		e.settle(t)
		if fin := e.col.final("job-r"); fin == nil || fin.Status != jobOK {
			t.Fatalf("final = %+v", fin)
		}
		w.check(t)
		if readLevel(t, e.dataDir()) != "LEVEL-1" {
			t.Fatal("the backup was not restored")
		}
		// Recreated and running even if it was asleep: mc-router does not see a container that never started; it
		// puts it back to sleep after the minutes without players.
		if c, _ := e.a.rec.Container(context.Background(), "a"); c == nil || c.ID == old || c.State != "running" || e.a.rec.Held("a") {
			t.Fatalf("asleep=%v: after restoring %+v", asleep, c)
		}
	}
}

func TestBlockedOnDemandServerIsParked(t *testing.T) {
	e := newOnDemandEnv(t)
	e.stopContainer(t)
	old := e.a.rec.ContainerID(context.Background(), "a")
	if err := os.Rename(e.dataDir(), e.dataDir()+".aside"); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = func(string, string, string) (backup.Recovery, error) {
		return backup.Recovery{}, fmt.Errorf("%w: simulated", backup.ErrDataMissing)
	}
	e.a.bk.recoverAtStart(context.Background())
	if !e.a.rec.Held("a") {
		t.Fatal("it must stay reserved")
	}
	var w wakeAttempt
	w.try(e, old) // Docker would create an empty data and the server a new world
	w.check(t)
	if _, err := os.Stat(e.dataDir()); !os.IsNotExist(err) {
		t.Fatalf("no new data must appear: %v", err)
	}
	if err := os.Rename(e.dataDir()+".aside", e.dataDir()); err != nil {
		t.Fatal(err)
	}
	e.a.bk.recoverDisk = backup.RecoverInterrupted
	e.a.bk.checkBlocked()
	e.settle(t)
	waitBackground(t, e.a)
	if c, _ := e.a.rec.Container(context.Background(), "a"); c == nil || c.ID == old || c.State != "running" || e.a.rec.Held("a") {
		t.Fatalf("with data back it is recreated and started: %+v held=%v", c, e.a.rec.Held("a"))
	}
}

func TestColdBackupParksOnDemandServer(t *testing.T) {
	e := newOnDemandEnv(t)
	e.stopContainer(t)
	old := e.a.rec.ContainerID(context.Background(), "a")
	var w wakeAttempt
	e.a.bk.freeSpace = func(string) (uint64, error) { // during the cold backup
		w.try(e, old)
		return 1 << 40, nil
	}
	e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-1"})
	e.settle(t)
	if fin := e.col.final("job-1"); fin == nil || fin.Status != jobOK {
		t.Fatalf("final = %+v", fin)
	}
	w.check(t)
	if c, _ := e.a.rec.Container(context.Background(), "a"); c == nil || c.ID == old || c.State != "running" {
		t.Fatalf("after the backup it is recreated and started: %+v", c)
	}
}

// Plans 7 × 8 (H1): the backup prior to a migration of an on-demand server is rejected and does not touch
// the container. Parking it (Park) is not enough: when the backup's reservation is released it would be recreated and started
// on the source (mc-router does not see those that never started), alive at the same time as the backup on the target; and
// without parking, mc-router could wake it midway through the backup or until the retirement. The panel already
// rejects it when planning (409); this covers an out-of-date view of the node's router.
func TestPreMigrationRefusesOnDemandServer(t *testing.T) {
	e := newOnDemandEnv(t)
	e.stopContainer(t) // migration step 1
	old := e.a.rec.ContainerID(context.Background(), "a")
	r := e.handle(10, &mcsmv1.BackupNow{ServerId: "a", JobId: "job-pre", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_PRE_MIGRATION})
	if errCode(r) != errcode.InvalidRequest || !strings.Contains(r.GetError().GetMessage(), "autoscale") {
		t.Fatalf("response = %+v", r)
	}
	e.settle(t)
	waitBackground(t, e.a)
	if cr := e.col.created(); len(cr) != 0 {
		t.Fatalf("there is no backup: %+v", cr)
	}
	c, err := e.a.rec.Container(context.Background(), "a")
	if err != nil || c == nil || c.ID != old || c.State != "exited" || e.a.rec.Held("a") {
		t.Fatalf("the container stays the same (stopped, not recreated) and without a reservation: %+v %v held=%v", c, err, e.a.rec.Held("a"))
	}
}
