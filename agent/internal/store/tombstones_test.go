package store

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"go.etcd.io/bbolt"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func spec(id string, v uint64) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: "s-" + id, Version: v, SpecJson: []byte(`{}`)}
}

// snapshot lee en UNA transacción si id tiene spec y si tiene lápida.
func (s *Store) snapshot(t *testing.T, id string) (hasSpec, hasTomb bool) {
	t.Helper()
	err := s.db.View(func(tx *bbolt.Tx) error {
		hasSpec = tx.Bucket(bSpecs).Get([]byte(id)) != nil
		if b := tx.Bucket(bTombstones); b != nil {
			hasTomb = b.Get([]byte(id)) != nil
		}
		return nil
	})
	if err != nil {
		t.Error(err)
	}
	return hasSpec, hasTomb
}

func TestTombstonesEmptyStore(t *testing.T) {
	s := open(t)
	if has, err := s.HasTombstone("a"); err != nil || has {
		t.Fatalf("HasTombstone = %v, %v", has, err)
	}
	if list, err := s.ListTombstones(); err != nil || len(list) != 0 {
		t.Fatalf("ListTombstones = %v, %v", list, err)
	}
	if err := s.DeleteTombstone("a"); err != nil {
		t.Fatalf("DeleteTombstone sin bucket = %v", err)
	}
}

func TestForgetWithTombstone(t *testing.T) {
	s := open(t)
	if err := s.PutSpec(spec("a", 3)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetApplied("a", 3); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSpec(spec("b", 1)); err != nil {
		t.Fatal(err)
	}
	at := time.UnixMilli(1_700_000_000_123)
	if err := s.ForgetWithTombstone("a", at); err != nil {
		t.Fatal(err)
	}
	if sp, _ := s.GetSpec("a"); sp != nil {
		t.Fatal("debe borrar la spec")
	}
	if v, _ := s.Applied("a"); v != 0 {
		t.Fatalf("debe borrar la versión aplicada: %d", v)
	}
	if has, err := s.HasTombstone("a"); err != nil || !has {
		t.Fatalf("HasTombstone = %v, %v", has, err)
	}
	list, err := s.ListTombstones()
	if err != nil || len(list) != 1 || list[0].ServerID != "a" || !list[0].Since.Equal(at) {
		t.Fatalf("ListTombstones = %+v, %v", list, err)
	}
	if specs, _ := s.ListSpecs(); len(specs) != 1 || specs[0].ServerId != "b" {
		t.Fatalf("una lápida no es una spec: %v", specs)
	}
	if vers, _ := s.SpecVersions(); len(vers) != 1 {
		t.Fatalf("una lápida no va en el Hello: %v", vers)
	}
	if err := s.ForgetWithTombstone("", at); err == nil {
		t.Fatal("id vacío debe fallar")
	}
}

func TestPutSpecClearsTombstone(t *testing.T) {
	s := open(t)
	if err := s.ForgetWithTombstone("a", time.UnixMilli(1)); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSpec(spec("a", 1)); err != nil {
		t.Fatal(err)
	}
	if has, _ := s.HasTombstone("a"); has {
		t.Fatal("guardar la spec anula la lápida")
	}
	if list, _ := s.ListTombstones(); len(list) != 0 {
		t.Fatalf("ListTombstones = %v", list)
	}
}

func TestDeleteTombstone(t *testing.T) {
	s := open(t)
	for _, id := range []string{"a", "b"} {
		if err := s.ForgetWithTombstone(id, time.UnixMilli(1)); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ { // idempotente
		if err := s.DeleteTombstone("a"); err != nil {
			t.Fatal(err)
		}
	}
	list, _ := s.ListTombstones()
	if len(list) != 1 || list[0].ServerID != "b" {
		t.Fatalf("ListTombstones = %+v", list)
	}
}

func TestTombstonesSurviveReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ForgetWithTombstone("a", time.UnixMilli(42)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	list, err := s2.ListTombstones()
	if err != nil || len(list) != 1 || list[0].ServerID != "a" || list[0].Since.UnixMilli() != 42 {
		t.Fatalf("ListTombstones = %+v, %v", list, err)
	}
}

// Spec y lápida de un id nunca conviven ni faltan las dos a la vez: ForgetWithTombstone y
// PutSpec son una sola transacción cada uno, así que un lector concurrente nunca ve un
// estado intermedio.
func TestForgetAndPutSpecAreAtomic(t *testing.T) {
	s := open(t)
	if err := s.PutSpec(spec("a", 1)); err != nil {
		t.Fatal(err)
	}
	const rounds = 100
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			if hasSpec, hasTomb := s.snapshot(t, "a"); hasSpec == hasTomb {
				t.Errorf("estado intermedio visible: spec=%v lápida=%v", hasSpec, hasTomb)
				return
			}
		}
	}()
	for i := uint64(0); i < rounds; i++ {
		if err := s.ForgetWithTombstone("a", time.UnixMilli(int64(i))); err != nil {
			t.Fatal(err)
		}
		if err := s.PutSpec(spec("a", i+2)); err != nil {
			t.Fatal(err)
		}
	}
	close(done)
	wg.Wait()
}
