package store

import (
	"path/filepath"
	"slices"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestCrashLatchRoundTripSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if l, err := s.CrashLatch("a"); err != nil || l != nil {
		t.Fatalf("without latch: %v %v", l, err)
	}
	if err := s.DeleteCrashLatch("a"); err != nil {
		t.Fatalf("deleting without a bucket is idempotent: %v", err)
	}
	if err := s.PutCrashLatch("", CrashLatch{}); err == nil {
		t.Fatal("a latch without id is not stored")
	}
	at := time.Date(2026, 10, 13, 4, 0, 0, 0, time.UTC)
	if err := s.PutCrashLatch("a", CrashLatch{Version: 3, Crashes: 4, At: at}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	l, err := s.CrashLatch("a")
	if err != nil || l == nil || l.Version != 3 || l.Crashes != 4 || !l.At.Equal(at) {
		t.Fatalf("after reopening: %+v %v", l, err)
	}
	if err := s.DeleteCrashLatch("a"); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.CrashLatch("a"); l != nil {
		t.Fatal("it must be deleted")
	}
}

func TestSaveOnPendingSetAndClear(t *testing.T) {
	s := open(t)
	if ids, err := s.SaveOnPending(); err != nil || len(ids) != 0 {
		t.Fatalf("empty: %v %v", ids, err)
	}
	now := time.Unix(1_000, 0)
	for _, id := range []string{"b", "a", "b"} {
		if err := s.MarkSaveOnPending(id, now); err != nil {
			t.Fatal(err)
		}
	}
	if ids, _ := s.SaveOnPending(); !slices.Equal(ids, []string{"a", "b"}) {
		t.Fatalf("ids = %v", ids)
	}
	if err := s.ClearSaveOnPending("a"); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearSaveOnPending("zzz"); err != nil {
		t.Fatalf("idempotent: %v", err)
	}
	if ids, _ := s.SaveOnPending(); !slices.Equal(ids, []string{"b"}) {
		t.Fatalf("ids = %v", ids)
	}
}

func TestDeleteSpecAndForgetDropLatchAndPending(t *testing.T) {
	s := open(t)
	for _, id := range []string{"a", "b"} {
		if err := s.PutSpec(&mcsmv1.ServerSpec{ServerId: id, Slug: id, Version: 1}); err != nil {
			t.Fatal(err)
		}
		if err := s.PutCrashLatch(id, CrashLatch{Version: 1, Crashes: 4}); err != nil {
			t.Fatal(err)
		}
		if err := s.MarkSaveOnPending(id, time.Unix(1, 0)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeleteSpec("a"); err != nil {
		t.Fatal(err)
	}
	if err := s.ForgetWithTombstone("b", time.Unix(2, 0)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if l, _ := s.CrashLatch(id); l != nil {
			t.Fatalf("%s: the latch is left over without a spec", id)
		}
	}
	if ids, _ := s.SaveOnPending(); len(ids) != 0 {
		t.Fatalf("pending = %v", ids)
	}
}
