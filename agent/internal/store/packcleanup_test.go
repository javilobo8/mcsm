package store

import (
	"reflect"
	"testing"
	"time"
)

func pending(t *testing.T, s *Store, id string) []string {
	t.Helper()
	got, err := s.PackCleanups(id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestPackCleanupMarker(t *testing.T) {
	s := open(t)
	if got := pending(t, s, "a"); len(got) != 0 {
		t.Fatalf("empty store: %v", got)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("a", 1), "MODRINTH"); err != nil {
		t.Fatal(err)
	}
	if got := pending(t, s, "a"); !reflect.DeepEqual(got, []string{"MODRINTH"}) {
		t.Fatalf("after one: %v", got)
	}
	if sp, _ := s.GetSpec("a"); sp == nil || sp.Version != 1 {
		t.Fatalf("the spec must be stored too: %+v", sp)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("a", 2), "AUTO_CURSEFORGE"); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("a", 3), "MODRINTH"); err != nil { // no duplicates
		t.Fatal(err)
	}
	if got := pending(t, s, "a"); !reflect.DeepEqual(got, []string{"AUTO_CURSEFORGE", "MODRINTH"}) {
		t.Fatalf("after two: %v", got)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("a", 4), ""); err != nil {
		t.Fatal(err)
	}
	if got := pending(t, s, "a"); len(got) != 2 {
		t.Fatalf(`"" must keep the set: %v`, got)
	}
	if sp, _ := s.GetSpec("a"); sp.Version != 4 {
		t.Fatalf(`"" stores the spec like PutSpec: %+v`, sp)
	}
	if got := pending(t, s, "b"); len(got) != 0 {
		t.Fatalf("another server: %v", got)
	}
	if err := s.ClearPackCleanup("a"); err != nil {
		t.Fatal(err)
	}
	if got := pending(t, s, "a"); len(got) != 0 {
		t.Fatalf("after clear: %v", got)
	}
	if err := s.ClearPackCleanup("never"); err != nil {
		t.Fatal(err)
	}
}

func TestPutSpecMarkingPackCleanupClearsTombstone(t *testing.T) {
	s := open(t)
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("a", 1), "MODRINTH"); err != nil {
		t.Fatal(err)
	}
	if hasSpec, hasTomb := s.snapshot(t, "a"); !hasSpec || hasTomb {
		t.Fatalf("spec=%v tombstone=%v", hasSpec, hasTomb)
	}
}

func TestPackCleanupGoesWithTheSpec(t *testing.T) {
	s := open(t)
	if err := s.PutSpecMarkingPackCleanup(spec("a", 1), "MODRINTH"); err != nil {
		t.Fatal(err)
	}
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if got := pending(t, s, "a"); len(got) != 0 {
		t.Fatalf("ForgetWithTombstone left %v", got)
	}
	if err := s.PutSpecMarkingPackCleanup(spec("b", 1), "AUTO_CURSEFORGE"); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSpec("b"); err != nil {
		t.Fatal(err)
	}
	if got := pending(t, s, "b"); len(got) != 0 {
		t.Fatalf("DeleteSpec left %v", got)
	}
}
