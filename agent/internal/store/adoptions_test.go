package store

import (
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestAdoptionsCRUD(t *testing.T) {
	s := open(t)
	if a, err := s.Adoption("a"); err != nil || a != nil {
		t.Fatalf("without bucket: %v, %v", a, err)
	}
	if err := s.DeleteAdoption("a"); err != nil {
		t.Fatalf("deleting without a bucket is idempotent: %v", err)
	}
	if err := s.PutAdoption("a", Adoption{ContainerID: "c1", Slug: "alpha", Version: 2}, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.PutAdoption("", Adoption{ContainerID: "c1"}, ""); err == nil {
		t.Fatal("without server_id it must fail")
	}
	if a, _ := s.Adoption("a"); a == nil || *a != (Adoption{ContainerID: "c1", Slug: "alpha", Version: 2}) {
		t.Fatalf("adoption = %+v", a)
	}
	if id, _ := s.AdoptedBy("c1"); id != "a" {
		t.Fatalf("AdoptedBy = %q", id)
	}
	if id, _ := s.AdoptedBy("c2"); id != "" {
		t.Fatalf("AdoptedBy of another = %q", id)
	}
	all, _ := s.Adoptions()
	if len(all) != 1 || all["a"].ContainerID != "c1" {
		t.Fatalf("adoptions = %+v", all)
	}
	if err := s.DeleteAdoption("a"); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.Adoption("a"); a != nil {
		t.Fatal("it must have been deleted")
	}
}

func TestAdoptWithSpecIsAtomicAndCancelsTombstone(t *testing.T) {
	s := open(t)
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	sp := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, SpecJson: []byte(`{}`)}
	if err := s.AdoptWithSpec(sp, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1}, ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetSpec("a"); got == nil || got.Slug != "alpha" {
		t.Fatalf("spec = %v", got)
	}
	if tomb, _ := s.HasTombstone("a"); tomb {
		t.Fatal("the spec clears the tombstone, like PutSpec")
	}
	if a, _ := s.Adoption("a"); a == nil || a.ContainerID != "c1" {
		t.Fatalf("adoption = %+v", a)
	}
}

func TestAdoptionSurvivesForget(t *testing.T) {
	s := open(t)
	_ = s.AdoptWithSpec(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1}, Adoption{ContainerID: "c1", Slug: "alpha", Version: 1}, "")
	if err := s.ForgetWithTombstone("a", time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.Adoption("a"); a == nil {
		t.Fatal("the pending deletion needs to know which container to stop")
	}
}
