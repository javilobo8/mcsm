package store

import (
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestJobs(t *testing.T) {
	s := open(t)
	if j, err := s.GetJob("nope"); err != nil || j != nil {
		t.Fatalf("GetJob sin bucket = %v, %v", j, err)
	}
	if list, err := s.ListJobs(); err != nil || len(list) != 0 {
		t.Fatalf("ListJobs sin bucket = %v, %v", list, err)
	}
	if err := s.PutJob(&mcsmv1.JobRecord{}); err == nil {
		t.Fatal("un job sin id debe rechazarse")
	}
	now := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	old := &mcsmv1.JobRecord{JobId: "old", Type: "backup", Status: mcsmv1.JobStatus_JOB_STATUS_OK, FinishedUnixMs: now.Add(-8 * 24 * time.Hour).UnixMilli()}
	recent := &mcsmv1.JobRecord{JobId: "recent", Type: "backup", Status: mcsmv1.JobStatus_JOB_STATUS_FAILED, FinishedUnixMs: now.Add(-time.Hour).UnixMilli()}
	running := &mcsmv1.JobRecord{JobId: "running", Type: "restore", Status: mcsmv1.JobStatus_JOB_STATUS_RUNNING, StartedUnixMs: 1}
	for _, j := range []*mcsmv1.JobRecord{old, recent, running} {
		if err := s.PutJob(j); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.GetJob("recent")
	if err != nil || got.Status != mcsmv1.JobStatus_JOB_STATUS_FAILED || got.Type != "backup" {
		t.Fatalf("GetJob = %+v, %v", got, err)
	}
	if list, _ := s.ListJobs(); len(list) != 3 {
		t.Fatalf("ListJobs = %d", len(list))
	}
	n, err := s.PruneJobs(now.Add(-7 * 24 * time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("PruneJobs = %d, %v", n, err)
	}
	if j, _ := s.GetJob("old"); j != nil {
		t.Fatal("el job antiguo debe borrarse")
	}
	if j, _ := s.GetJob("running"); j == nil {
		t.Fatal("un job en curso nunca se poda")
	}
}
