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

// TestMigrateRetireImportedRemovesOriginalContainer: retiring from the source an imported
// server not yet recreated (Plan 6) finds it through its adoption, stops and deletes the user's
// ORIGINAL container, forgets the adoption and sets its data aside from DATA_ROOT, just like with a
// managed one (Plans 6 and 7). The web warns about it when confirming the migration.
func TestMigrateRetireImportedRemovesOriginalContainer(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	data := filepath.Join(a.cfg.DataRoot, "old", "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "level.dat"), []byte("MUNDO"), 0o644); err != nil {
		t.Fatal(err)
	}
	id := foreignItzg(t, fake, "old", data)
	a.Handle(ctx, adoptEnv(9, "s1", "old", adoptJSON(id)), s.send)
	if e := s.waitID(t, 9); e.GetAck() == nil {
		t.Fatalf("adoption = %v", e)
	}

	retire := &mcsmv1.MigrateRetire{ServerId: "s1", Slug: "old", MigrationId: "mig-1", SourceVersion: 1}
	a.Handle(ctx, migrateEnvelope(10, retire), s.send)
	if e := s.waitID(t, 10); e.GetAck() == nil {
		t.Fatalf("retirement = %v", e)
	}
	if _, err := fake.Inspect(ctx, id); !errors.Is(err, docker.ErrNotFound) {
		t.Fatalf("the original container must be deleted: err = %v", err)
	}
	if ad, err := st.Adoption("s1"); err != nil || ad != nil {
		t.Fatalf("the adoption must be forgotten: %+v, %v", ad, err)
	}
	if sp, err := st.GetSpec("s1"); err != nil || sp != nil {
		t.Fatalf("the spec must be forgotten: %+v, %v", sp, err)
	}
	if _, err := os.Stat(filepath.Join(a.cfg.DataRoot, "old")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("<DATA_ROOT>/old must be set aside: %v", err)
	}
	aside, _ := filepath.Glob(filepath.Join(a.cfg.DataRoot, "old.migrated-*", "data", "level.dat"))
	if len(aside) != 1 {
		t.Fatalf("set aside = %v", aside)
	}
	if b, err := os.ReadFile(aside[0]); err != nil || string(b) != "MUNDO" {
		t.Fatalf("the world set aside = %q, %v", b, err)
	}
	a.Handle(ctx, migrateEnvelope(11, retire), s.send)
	if e := s.waitID(t, 11); e.GetAck() == nil {
		t.Fatalf("repeating it does nothing: %v", e)
	}
}
