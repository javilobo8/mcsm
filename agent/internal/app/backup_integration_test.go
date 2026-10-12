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

// Prueba contra Docker real (spec §11): servidor itzg VANILLA, copia en caliente con
// save-off/save-on, restauración y limpieza. Solo crea recursos mcsm-test-*. La primera vez
// tarda varios minutos (imagen itzg y descarga del servidor).
func TestIntegrationBackupRestore(t *testing.T) {
	if uid := os.Getuid(); uid != 0 && uid != 1000 {
		t.Skip("la imagen itzg escribe /data con el uid 1000: ejecuta la prueba con ese usuario o como root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	eng, err := docker.NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	const netName, serverID, slug = "mcsm-test-backup-net", "int-backup", "test-backup" // contenedor mcsm-test-backup
	if err := eng.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() }) // Cleanup es LIFO: se cierra después de borrar el servidor
	a := New(Config{DataRoot: t.TempDir(), Network: netName, Version: "integration"}, st, eng, slog.Default())
	col := newCollector()
	a.send = col.send
	// Sin Run, la cola de avisos al panel (jobs, copias creadas) no corre: se arranca aquí.
	octx, ocancel := context.WithCancel(ctx)
	a.bk.loop(func() { a.bk.out.run(octx) })
	t.Cleanup(func() { ocancel(); a.bk.wg.Wait(); a.bk.loops.Wait() })
	// El test corre en el host, fuera de la red Docker: RCON con el rcon-cli de la imagen itzg.
	// Con stopOnFlush, tras save-all flush se para el contenedor (paso 3: parada a mitad de copia).
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
			t.Errorf("limpieza: %v (borra a mano el contenedor mcsm-test-backup)", err)
		}
		_ = exec.Command("docker", "network", "rm", netName).Run()
	})

	specJS := fmt.Sprintf(`{"imageTag":"latest","type":"VANILLA","version":"1.21.4","memory":"1G","ports":{"game":%d},"restartPolicy":"no","rconPassword":"integration-pass","env":{"ONLINE_MODE":"FALSE"}}`, freePort(t))
	if err := a.rec.Apply(ctx, &mcsmv1.ServerSpec{ServerId: serverID, Slug: slug, Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJS)}); err != nil {
		t.Fatal(err)
	}
	waitHealthy(ctx, t, a, serverID)

	// 1. Copia en caliente.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: serverID, JobId: "int-job-1"}}}, col.send)
	settle(t, a)
	if fin := col.final("int-job-1"); fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_OK {
		t.Fatalf("copia = %+v", fin)
	}
	out, err := a.rcon(ctx, "mcsm-"+slug, 0, "", "save-on")
	if err != nil || !strings.Contains(out, "already") {
		t.Fatalf("tras la copia el autosave debe estar activo (save-on → %q, %v)", out, err)
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
		t.Fatalf("la copia debe contener el mundo: %v", err)
	}

	// 2. Restauración: los datos actuales se apartan y el servidor vuelve a arrancar.
	dataDir := filepath.Join(a.cfg.DataRoot, slug, "data")
	if err := os.WriteFile(filepath.Join(dataDir, "marca-posterior.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_BackupRestore{BackupRestore: &mcsmv1.BackupRestore{ServerId: serverID, Filename: name, JobId: "int-job-2"}}}, col.send)
	settle(t, a)
	if fin := col.final("int-job-2"); fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_OK {
		t.Fatalf("restauración = %+v", fin)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "marca-posterior.txt")); !os.IsNotExist(err) {
		t.Fatal("tras restaurar no debe estar la marca posterior a la copia")
	}
	pres, _ := backup.ListPreRestore(dataDir)
	if len(pres) != 1 {
		t.Fatalf("pre-restore = %+v", pres)
	}
	if _, err := os.Stat(filepath.Join(a.cfg.DataRoot, slug, pres[0].Filename, "marca-posterior.txt")); err != nil {
		t.Fatal("los datos anteriores deben conservarse en el directorio pre-restore")
	}
	waitHealthy(ctx, t, a, serverID)

	// 3. El contenedor se para durante una copia en caliente (como el autoscale de mc-router):
	// Minecraft guarda al pararse, así que la copia se descarta y no se anuncia.
	backupsDir := backup.Dir(a.cfg.DataRoot, slug)
	before, _ := os.ReadDir(backupsDir)
	nCreated := len(col.created()) // la de 1 y los datos pre-restore de 2
	stopOnFlush.Store(true)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: serverID, JobId: "int-job-3"}}}, col.send)
	settle(t, a)
	stopOnFlush.Store(false)
	fin := col.final("int-job-3")
	t.Logf("copia con parada: %+v", fin)
	if fin == nil || fin.Status != mcsmv1.JobStatus_JOB_STATUS_FAILED || !strings.Contains(fin.Message, "se paró o se reinició") ||
		!strings.Contains(fin.Message, "descartado") || strings.Contains(fin.Message, "save-on") {
		t.Fatalf("copia con parada = %+v", fin)
	}
	if got := col.created(); len(got) != nCreated {
		t.Fatalf("una copia descartada no se anuncia: %+v", got)
	}
	if after, _ := os.ReadDir(backupsDir); len(after) != len(before) {
		t.Fatalf("la copia descartada no deja ficheros: antes %v, después %v", before, after)
	}
	waitHealthy(ctx, t, a, serverID) // al liberar la reserva se reconcilia: vuelve a arrancar
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

// waitHealthy consulta el healthcheck de la imagen itzg hasta que el servidor responde.
func waitHealthy(ctx context.Context, t *testing.T, a *App, serverID string) {
	t.Helper()
	for {
		if obs := a.rec.Observe(ctx, serverID); obs.Health == "healthy" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("el servidor no llegó a healthy a tiempo")
		case <-time.After(5 * time.Second): // sondeo de un recurso externo: aquí sí se espera
		}
	}
}

// settle espera a que terminen los jobs en segundo plano y a que la cola de avisos entregue lo emitido.
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
		t.Fatal("los jobs no terminaron")
	}
}
