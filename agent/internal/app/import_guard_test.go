package app

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
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
	}
}
