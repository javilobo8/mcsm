package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
)

// TestMigrateRetireImportedRemovesOriginalContainer: la retirada del origen de un servidor
// importado aún sin recrear (Plan 6) lo encuentra por su adopción, para y borra el contenedor
// ORIGINAL del usuario, olvida la adopción y aparta sus datos de DATA_ROOT, igual que con un
// gestionado (Planes 6 y 7). La web lo avisa al confirmar la migración.
func TestMigrateRetireImportedRemovesOriginalContainer(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	data := filepath.Join(a.cfg.DataRoot, "viejo", "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "level.dat"), []byte("MUNDO"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := foreignItzg(t, fake, "viejo", data)
	a.Handle(ctx, adoptEnv(9, "s1", "viejo", adoptJSON(id)), s.send)
	if e := s.waitID(t, 9); e.GetAck() == nil {
		t.Fatalf("adopción = %v", e)
	}

	retire := &mcsmv1.MigrateRetire{ServerId: "s1", Slug: "viejo", MigrationId: "mig-1", SourceVersion: 1}
	a.Handle(ctx, migrateEnvelope(10, retire), s.send)
	if e := s.waitID(t, 10); e.GetAck() == nil {
		t.Fatalf("retirada = %v", e)
	}
	if _, err := fake.Inspect(ctx, id); !errors.Is(err, docker.ErrNotFound) {
		t.Fatalf("el contenedor original debe borrarse: err = %v", err)
	}
	if ad, err := st.Adoption("s1"); err != nil || ad != nil {
		t.Fatalf("la adopción debe olvidarse: %+v, %v", ad, err)
	}
	if sp, err := st.GetSpec("s1"); err != nil || sp != nil {
		t.Fatalf("la spec debe olvidarse: %+v, %v", sp, err)
	}
	if _, err := os.Stat(filepath.Join(a.cfg.DataRoot, "viejo")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("<DATA_ROOT>/viejo debe apartarse: %v", err)
	}
	aside, _ := filepath.Glob(filepath.Join(a.cfg.DataRoot, "viejo.migrated-*", "data", "level.dat"))
	if len(aside) != 1 {
		t.Fatalf("apartado = %v", aside)
	}
	if b, err := os.ReadFile(aside[0]); err != nil || string(b) != "MUNDO" {
		t.Fatalf("el mundo apartado = %q, %v", b, err)
	}
	a.Handle(ctx, migrateEnvelope(11, retire), s.send)
	if e := s.waitID(t, 11); e.GetAck() == nil {
		t.Fatalf("repetirla no hace nada: %v", e)
	}
}
