package app

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
)

// foreignItzg crea y arranca un contenedor itzg ajeno con ese bind de /data.
func foreignItzg(t *testing.T, fake *docker.Fake, name, dataSrc string) string {
	t.Helper()
	ctx := context.Background()
	id, err := fake.Create(ctx, name, &container.Config{Image: "itzg/minecraft-server:java21", Env: []string{"EULA=TRUE"}},
		&container.HostConfig{Binds: []string{dataSrc + ":/data"}, PortBindings: network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25570"}}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func adoptJSON(containerID string) []byte {
	return []byte(`{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25570},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","adopt":{"containerId":"` + containerID + `","version":1}}`)
}

func adoptEnv(id uint64, serverID, slug string, js []byte) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ImportAdopt{ImportAdopt: &mcsmv1.ImportAdopt{Server: &mcsmv1.ServerSpec{
		ServerId: serverID, Slug: slug, Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: js,
	}}}}
}

func TestImportScanResult(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	fake.ImageEnvs["itzg/minecraft-server:java21"] = []string{"EULA=TRUE"}
	id := foreignItzg(t, fake, "viejo", "/home/lobo/mc/viejo")
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_ImportScan{ImportScan: &mcsmv1.ImportScan{}}}, s.send)
	res := s.waitID(t, 5).GetImportScanResult()
	if res == nil || res.DataRoot != a.cfg.DataRoot || len(res.Candidates) != 1 || res.Candidates[0].ContainerId != id || len(res.Candidates[0].Env) != 0 {
		t.Fatalf("resultado = %+v", res)
	}
}

func TestImportAdoptAndErrors(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	id := foreignItzg(t, fake, "viejo", filepath.Join(a.cfg.DataRoot, "viejo", "data"))

	a.Handle(ctx, adoptEnv(9, "s1", "viejo", adoptJSON(id)), s.send)
	if e := s.waitID(t, 9); e.GetAck() == nil {
		t.Fatalf("respuesta = %v", e)
	}
	if ad, _ := st.Adoption("s1"); ad == nil || ad.ContainerID != id {
		t.Fatalf("adoption = %+v", ad)
	}
	if got := a.rec.ContainerID(ctx, "s1"); got != id {
		t.Fatalf("ContainerID = %q", got)
	}

	// Escaneo posterior: el adoptado ya no es candidato.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 10, Body: &mcsmv1.Envelope_ImportScan{ImportScan: &mcsmv1.ImportScan{}}}, s.send)
	if res := s.waitID(t, 10).GetImportScanResult(); res == nil || len(res.Candidates) != 0 {
		t.Fatalf("resultado = %+v", res)
	}

	// Otro contenedor itzg (parado) cuyo /data no es el de la spec.
	other, err := fake.Create(ctx, "otro-mc", &container.Config{Image: "itzg/minecraft-server:java21"},
		&container.HostConfig{Binds: []string{"/home/lobo/mc/otro:/data"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		id     uint64
		server string
		slug   string
		js     []byte
		want   string
	}{
		{11, "s2", "otro", adoptJSON("fake0999"), errcode.NotFound},
		{12, "s3", "viejo", adoptJSON(id), errcode.Exists},           // ya adoptado por s1
		{13, "s4", "otro", adoptJSON(other), errcode.InvalidRequest}, // su /data no es DATA_ROOT/otro/data
		{14, "s5", "Mal Slug", adoptJSON(id), errcode.InvalidSpec},
		{15, "s6", "otro", []byte(`{"type":"PAPER"}`), errcode.InvalidSpec},
	}
	for _, c := range cases {
		a.Handle(ctx, adoptEnv(c.id, c.server, c.slug, c.js), s.send)
		e := s.waitID(t, c.id)
		if e.GetError() == nil || e.GetError().Code != c.want {
			t.Errorf("caso %d: respuesta = %v; want %s", c.id, e, c.want)
		}
	}
}
