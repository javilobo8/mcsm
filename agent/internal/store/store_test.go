package store

import (
	"path/filepath"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCredentials(t *testing.T) {
	s := open(t)
	c, err := s.Credentials()
	if err != nil || c != nil {
		t.Fatalf("expected nil,nil; got %v,%v", c, err)
	}
	if err := s.SaveCredentials(Credentials{NodeID: "n1", Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	c, _ = s.Credentials()
	if c == nil || c.NodeID != "n1" || c.Token != "tok" {
		t.Fatalf("got %+v", c)
	}
}

func TestSpecs(t *testing.T) {
	s := open(t)
	if sp, _ := s.GetSpec("missing"); sp != nil {
		t.Fatal("GetSpec of a nonexistent id must return nil")
	}
	a := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(`{"x":1}`)}
	b := &mcsmv1.ServerSpec{ServerId: "b", Slug: "beta", Version: 5}
	for _, sp := range []*mcsmv1.ServerSpec{a, b} {
		if err := s.PutSpec(sp); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := s.GetSpec("a")
	if got.Slug != "alpha" || got.Version != 2 || string(got.SpecJson) != `{"x":1}` || got.DesiredState != mcsmv1.DesiredState_DESIRED_STATE_RUNNING {
		t.Fatalf("got %+v", got)
	}
	list, _ := s.ListSpecs()
	if len(list) != 2 {
		t.Fatalf("len = %d", len(list))
	}
	vers, _ := s.SpecVersions()
	if vers["a"] != 2 || vers["b"] != 5 {
		t.Fatalf("vers = %v", vers)
	}
	if err := s.SetApplied("a", 2); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Applied("a"); v != 2 {
		t.Fatalf("applied = %d", v)
	}
	if v, _ := s.Applied("b"); v != 0 {
		t.Fatalf("applied b = %d, want 0", v)
	}
	if err := s.DeleteSpec("a"); err != nil {
		t.Fatal(err)
	}
	if sp, _ := s.GetSpec("a"); sp != nil {
		t.Fatal("a should have been deleted")
	}
	if v, _ := s.Applied("a"); v != 0 {
		t.Fatal("DeleteSpec must also delete applied")
	}
}
