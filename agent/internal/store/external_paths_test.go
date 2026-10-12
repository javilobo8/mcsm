package store

import (
	"path/filepath"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestExternalPaths(t *testing.T) {
	s := open(t)
	if p, err := s.ExternalPath("a"); err != nil || p != "" {
		t.Fatalf("sin bucket: %q, %v", p, err)
	}
	if err := s.PutExternalPath("a", "/srv/viejo/data"); err != nil {
		t.Fatal(err)
	}
	if err := s.PutExternalPath("", "/srv/x"); err == nil {
		t.Fatal("sin server_id debe fallar")
	}
	if err := s.PutExternalPath("a", ""); err == nil {
		t.Fatal("sin ruta debe fallar")
	}
	if p, _ := s.ExternalPath("a"); p != "/srv/viejo/data" {
		t.Fatalf("ruta = %q", p)
	}
	// Sobrevive a Forget y DeleteSpec: solo identifica la carpeta que se verificó para ese id.
	_ = s.ForgetWithTombstone("a", time.Unix(1, 0))
	_ = s.DeleteSpec("a")
	if p, _ := s.ExternalPath("a"); p != "/srv/viejo/data" {
		t.Fatalf("tras retirar: %q", p)
	}
}

func TestExternalPathSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AdoptWithSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1}, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1}, "/srv/viejo/data"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if p, _ := s.ExternalPath("a"); p != "/srv/viejo/data" {
		t.Fatalf("tras reabrir: %q", p)
	}
}

func TestAdoptWithSpecKeepsNewerSpec(t *testing.T) {
	s := open(t)
	if err := s.PutSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, SpecJson: []byte(`{"v":2}`)}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdoptWithSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, SpecJson: []byte(`{"v":1}`)}, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1}, ""); err != nil {
		t.Fatal(err)
	}
	if sp, _ := s.GetSpec("a"); sp == nil || sp.Version != 2 || string(sp.SpecJson) != `{"v":2}` {
		t.Fatalf("una spec más nueva no se pisa: %v", sp)
	}
	if a, _ := s.Adoption("a"); a == nil || a.ContainerID != "c1" || a.Version != 1 {
		t.Fatalf("la adopción sí se guarda: %+v", a)
	}
	if p, _ := s.ExternalPath("a"); p != "" {
		t.Fatalf("sin dataPath no se registra carpeta: %q", p)
	}
}
