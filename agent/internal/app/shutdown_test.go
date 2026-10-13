package app

import (
	"testing"
	"time"
)

// The shutdown waits (Files* and backups) run at the same time: each one only finishes when
// the other has already started. In series, the first would never return.
func TestWaitAllRunsWaitsInParallel(t *testing.T) {
	aStarted, bStarted := make(chan struct{}), make(chan struct{})
	done := make(chan bool, 1)
	go func() {
		done <- waitAll(
			func() bool { close(aStarted); <-bStarted; return true },
			func() bool { close(bStarted); <-aStarted; return false },
		)
	}()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("waitAll = true with an expired wait")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the shutdown waits do not run in parallel")
	}
}

func TestWaitAllTrueWhenAllFinish(t *testing.T) {
	if !waitAll(func() bool { return true }, func() bool { return true }) {
		t.Fatal("waitAll = false with all the waits on time")
	}
	if !waitAll() {
		t.Fatal("waitAll() without waits = false")
	}
}
