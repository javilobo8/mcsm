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

// snapshot reads in ONE transaction whether id has a spec and whether it has a tombstone.
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
		t.Fatalf("DeleteTombstone without bucket = %v", err)
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
		t.Fatal("it must delete the spec")
	}
	if v, _ := s.Applied("a"); v != 0 {
		t.Fatalf("it must delete the applied version: %d", v)
	}
	if has, err := s.HasTombstone("a"); err != nil || !has {
		t.Fatalf("HasTombstone = %v, %v", has, err)
	}
	list, err := s.ListTombstones()
	if err != nil || len(list) != 1 || list[0].ServerID != "a" || !list[0].Since.Equal(at) {
		t.Fatalf("ListTombstones = %+v, %v", list, err)
	}
	if specs, _ := s.ListSpecs(); len(specs) != 1 || specs[0].ServerId != "b" {
		t.Fatalf("a tombstone is not a spec: %v", specs)
	}
	if vers, _ := s.SpecVersions(); len(vers) != 1 {
		t.Fatalf("a tombstone does not go in the Hello: %v", vers)
	}
	if err := s.ForgetWithTombstone("", at); err == nil {
		t.Fatal("an empty id must fail")
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
		t.Fatal("storing the spec clears the tombstone")
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
	for i := 0; i < 2; i++ { // idempotent
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

// A spec and a tombstone for an id never coexist nor are both missing at once: ForgetWithTombstone and
// PutSpec are a single transaction each, so a concurrent reader never sees an
// intermediate state.
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
				t.Errorf("intermediate state visible: spec=%v tombstone=%v", hasSpec, hasTomb)
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
