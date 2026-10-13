//go:build integration

package app

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

// Test against real Docker (spec §11): VANILLA itzg server, hot backup with
// save-off/save-on, restore and cleanup. It only creates mcsm-test-* resources. The first time
// it takes several minutes (itzg image and server download).
func TestIntegrationBackupRestore(t *testing.T) {
	if uid := os.Getuid(); uid != 0 && uid != 1000 {
		t.Skip("the itzg image writes /data with uid 1000: run the test as that user or as root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	eng, err := docker.NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	const netName, serverID, slug = "mcsm-test-backup-net", "int-backup", "test-backup" // container mcsm-test-backup
	if err := eng.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() }) // Cleanup is LIFO: it closes after deleting the server
	a := New(Config{DataRoot: t.TempDir(), Network: netName, Version: "integration"}, st, eng, slog.Default())
	col := newCollector()
	a.send = col.send
	// Without Run, the queue of notices to the panel (jobs, created backups) does not run: it is started here.
	octx, ocancel := context.WithCancel(ctx)
	a.bk.loop(func() { a.bk.out.run(octx) })
	t.Cleanup(func() { ocancel(); a.bk.wg.Wait(); a.bk.loops.Wait() })
	// The test runs on the host, outside the Docker network: RCON with the itzg image's rcon-cli.
	// With stopOnFlush, after save-all flush the container is stopped (step 3: stop midway through a backup).
	var stopOnFlush atomic.Bool
	a.rcon = func(ctx context.Context, host string, _ uint16, _ string, cmd string) (string, error) {
		out, err := exec.CommandContext(ctx, "docker", append([]string{"exec", host, "rcon-cli"}, strings.Fields(cmd)...)...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("%v: %s", err, out)
		}
		if cmd == "save-all flush" && stopOnFlush.Load() {
			if sout, serr := exec.CommandContext(ctx, "docker", "stop", host).CombinedOutput(); serr != nil {
				return "", fmt.Errorf("docker stop: %v: %s", serr, sout)
			}
		}
		return string(out), nil
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := a.rec.Remove(cctx, serverID, false); err != nil {
			t.Errorf("cleanup: %v (delete the mcsm-test-backup container by hand)", err)
		}
		_ = exec.Command("docker", "network", "rm", netName).Run()
	})

	specJS := fmt.Sprintf(`{"imageTag":"latest","type":"VANILLA","version":"1.21.4","memory":"1G","ports":{"game":%d},"restartPolicy":"no","rconPassword":"integration-pass","env":{"ONLINE_MODE":"FALSE"}}`, freePort(t))
	if err := a.rec.Apply(ctx, &mcsmv1.ServerSpec{ServerId: serverID, Slug: slug, Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJS)}); err != nil {
		t.Fatal(err)
	}
	waitHealthy(ctx, t, a, serverID)

	// 1. Hot backup.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: serverID, JobId: "int-job-1"}}}, col.send)
	settle(t, a)
	if fin := col.final("int-job-1"); fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_OK {
		t.Fatalf("backup = %+v", fin)
	}
	out, err := a.rcon(ctx, "mcsm-"+slug, 0, "", "save-on")
	if err != nil || !strings.Contains(out, "already") {
		t.Fatalf("after the backup autosave must be active (save-on → %q, %v)", out, err)
	}
	created := col.created()
	name := created[0].Filename
	data, err := os.ReadFile(filepath.Join(backup.Dir(a.cfg.DataRoot, slug), name))
	if err != nil {
		t.Fatal(err)
	}
	probe := t.TempDir()
	if err := backup.ExtractArchive(ctx, bytes.NewReader(data), probe, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(probe, "world", "level.dat")); err != nil {
		t.Fatalf("the backup must contain the world: %v", err)
	}

	// 2. Restore: the current data is set aside and the server starts again.
	dataDir := filepath.Join(a.cfg.DataRoot, slug, "data")
	if err := os.WriteFile(filepath.Join(dataDir, "mark-after.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_BackupRestore{BackupRestore: &mcsmv1.BackupRestore{ServerId: serverID, Filename: name, JobId: "int-job-2"}}}, col.send)
	settle(t, a)
	if fin := col.final("int-job-2"); fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_OK {
		t.Fatalf("restore = %+v", fin)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "mark-after.txt")); !os.IsNotExist(err) {
		t.Fatal("after restoring the mark made after the backup must not be there")
	}
	pres, _ := backup.ListPreRestore(dataDir)
	if len(pres) != 1 {
		t.Fatalf("pre-restore = %+v", pres)
	}
	if _, err := os.Stat(filepath.Join(a.cfg.DataRoot, slug, pres[0].Filename, "mark-after.txt")); err != nil {
		t.Fatal("the previous data must be kept in the pre-restore directory")
	}
	waitHealthy(ctx, t, a, serverID)

	// 3. The container stops during a hot backup (like mc-router's autoscale):
	// Minecraft saves when stopping, so the backup is discarded and not announced.
	backupsDir := backup.Dir(a.cfg.DataRoot, slug)
	before, _ := os.ReadDir(backupsDir)
	nCreated := len(col.created()) // the one from 1 and the pre-restore data from 2
	stopOnFlush.Store(true)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: serverID, JobId: "int-job-3"}}}, col.send)
	settle(t, a)
	stopOnFlush.Store(false)
	fin := col.final("int-job-3")
	t.Logf("backup with stop: %+v", fin)
	if fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_FAILED || !strings.Contains(fin.Message, "stopped or restarted") ||
		!strings.Contains(fin.Message, "discarded") || strings.Contains(fin.Message, "save-on") {
		t.Fatalf("backup with stop = %+v", fin)
	}
	if got := col.created(); len(got) != nCreated {
		t.Fatalf("a discarded backup is not announced: %+v", got)
	}
	if after, _ := os.ReadDir(backupsDir); len(after) != len(before) {
		t.Fatalf("the discarded backup leaves no files: before %v, after %v", before, after)
	}
	waitHealthy(ctx, t, a, serverID) // when the reservation is released it reconciles: it starts again
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// waitHealthy queries the itzg image's healthcheck until the server responds.
func waitHealthy(ctx context.Context, t *testing.T, a *App, serverID string) {
	t.Helper()
	for {
		if obs := a.rec.Observe(ctx, serverID); obs.Health == "healthy" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("the server did not reach healthy in time")
		case <-time.After(5 * time.Second): // probing an external resource: waiting is appropriate here
		}
	}
}

// settle waits for the background jobs to finish and for the notice queue to deliver what was emitted.
func settle(t *testing.T, a *App) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.bk.wg.Wait()
		mark := make(chan struct{})
		a.bk.out.ch <- outItem{mark: mark}
		<-mark
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Minute):
		t.Fatal("the jobs did not finish")
	}
}
