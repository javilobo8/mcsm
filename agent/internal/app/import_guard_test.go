package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/backup"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/stats"
)

func TestSamplerMeasuresAdopted(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	id := foreignItzg(t, fake, "viejo", filepath.Join(a.cfg.DataRoot, "viejo", "data"))
	a.Handle(ctx, adoptEnv(1, "s1", "viejo", adoptJSON(id)), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("adoptar: %v", e)
	}
	a.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		return &mcsmv1.McStatus{Online: host == "mcsm-viejo", PlayersOnline: 1, PlayersMax: 20}
	}
	sm := a.newSampler(&hostStub{}, stats.RealClock, func(context.Context, string, uint16, string) (stats.Rcon, error) { return &rconStub{}, nil })
	t0 := time.Date(2026, 10, 12, 10, 0, 5, 0, time.UTC)
	fake.SetStats(id, docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	sm.Sample(ctx, t0)
	fake.SetStats(id, docker.Stats{CPUTotalNs: 2e9, SystemCPUNs: 20e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	b := sm.Sample(ctx, t0.Add(10*time.Second))
	if b == nil || len(b.Servers) != 1 || b.Servers[0].ServerId != "s1" || !b.Servers[0].McOnline || b.Servers[0].PlayersMax != 20 {
		t.Fatalf("lote = %+v: el adoptado se mide y se le hace ping por mcsm-viejo", b)
	}
}

// dataPathSpec es una spec con los datos fuera de DATA_ROOT (sin adopt: el agente crea el gestionado).
const dataPathSpec = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25571},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","dataPath":"/mcsm-test-noexiste/externo/data"}`

func applyDataPathServer(t *testing.T, a *App, s *sink) {
	t.Helper()
	// La carpeta la verificó una importación (H1): sin eso el agente no la monta.
	if err := a.st.PutExternalPath("e", "/mcsm-test-noexiste/externo/data"); err != nil {
		t.Fatal(err)
	}
	sp := &mcsmv1.ServerSpec{ServerId: "e", Slug: "externo", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_STOPPED, SpecJson: []byte(dataPathSpec)}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("ApplySpec: %v", e)
	}
}

func TestFilesAndBackupsRefusedWithDataPath(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	applyDataPathServer(t, a, s)
	for _, env := range []*mcsmv1.Envelope{
		{Id: 2, Body: &mcsmv1.Envelope_FilesList{FilesList: &mcsmv1.FilesList{ServerId: "e", Path: "/"}}},
		{Id: 3, Body: &mcsmv1.Envelope_BackupNow{BackupNow: &mcsmv1.BackupNow{ServerId: "e", JobId: "j1", Trigger: mcsmv1.BackupTrigger_BACKUP_TRIGGER_MANUAL}}},
		{Id: 4, Body: &mcsmv1.Envelope_BackupRestore{BackupRestore: &mcsmv1.BackupRestore{ServerId: "e", JobId: "j2", Filename: "externo-20261012T100000.000Z-1.tar.zst"}}},
	} {
		a.Handle(ctx, env, s.send)
		e := s.waitID(t, env.Id)
		if e.GetError() == nil || e.GetError().Code != errcode.ExternalData || !strings.Contains(e.GetError().Message, "/mcsm-test-noexiste/externo/data") {
			t.Errorf("%T: respuesta = %v", env.Body, e)
		}
		// Quitar dataPath recrearía el servidor sobre una carpeta vacía: el camino es volver a importarlo.
		if msg := e.GetError().GetMessage(); !strings.Contains(msg, "vuelve a importarlo") || strings.Contains(msg, "quita dataPath") {
			t.Errorf("%T: mensaje = %q", env.Body, msg)
		}
	}
}

// H1: un dataPath que el agente no verificó al importar no se monta; el panel recibe bad_spec.
func TestApplyUnverifiedDataPathIsBadSpec(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	js := strings.Replace(dataPathSpec, "/mcsm-test-noexiste/externo/data", "/root/mc", 1)
	sp := &mcsmv1.ServerSpec{ServerId: "e", Slug: "externo", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(js)}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
	e := s.waitID(t, 1)
	if e.GetError().GetCode() != errcode.BadSpec || !strings.Contains(e.GetError().GetMessage(), "/root/mc") {
		t.Fatalf("respuesta = %v", e)
	}
	if len(fake.Containers) != 0 {
		t.Fatalf("no se crea nada: %v", fake.Calls)
	}
}

// m3: con dataPath el agente no ve la carpeta de datos (solo monta DATA_ROOT): la recuperación al
// arrancar, el inventario de pre-restore y el barrido de temporales no la tocan.
func putDataPathSpec(t *testing.T, a *App, dataPath string) {
	t.Helper()
	js := strings.Replace(dataPathSpec, "/mcsm-test-noexiste/externo/data", dataPath, 1)
	if err := a.st.PutSpec(&mcsmv1.ServerSpec{ServerId: "e", Slug: "externo", Version: 1, SpecJson: []byte(js)}); err != nil {
		t.Fatal(err)
	}
}

func TestRecoverAtStartSkipsDataPath(t *testing.T) {
	a, _, _ := newApp(t)
	putDataPathSpec(t, a, "/mcsm-test-noexiste/externo/data")
	called := false
	a.bk.recoverDisk = func(string, string, string) (backup.Recovery, error) { called = true; return backup.Recovery{}, nil }
	a.bk.recoverServer("e")
	if called {
		t.Fatal("no se recupera una carpeta que el agente no ve")
	}
}

func TestInventorySkipsDataPathPreRestore(t *testing.T) {
	a, _, _ := newApp(t)
	dataPath := filepath.Join(t.TempDir(), "mundo", "data")
	pre := filepath.Join(filepath.Dir(dataPath), backup.PreRestoreName(dataPath, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)))
	if err := os.MkdirAll(pre, 0o755); err != nil {
		t.Fatal(err)
	}
	putDataPathSpec(t, a, dataPath)
	infos, err := a.bk.listing("e")
	if err != nil || len(infos) != 0 {
		t.Fatalf("listing = %v, %v", infos, err)
	}
}

func TestSweepTempsSkipsDataPath(t *testing.T) {
	a, _, _ := newApp(t)
	putDataPathSpec(t, a, "/mcsm-test-noexiste/externo/data")
	// <DATA_ROOT>/<slug>/data no es la carpeta de este servidor: lo que haya ahí no se toca.
	dir := filepath.Join(a.cfg.DataRoot, "externo", "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, ".mcsm-tmp-0123456789abcdef")
	if err := os.WriteFile(tmp, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(tmp, old, old); err != nil {
		t.Fatal(err)
	}
	a.sweepTemps(context.Background())
	if _, err := os.Stat(tmp); err != nil {
		t.Fatalf("no se barre: %v", err)
	}
}
