package app

import (
	"testing"
	"time"
)

// Las esperas del cierre (Files* y copias) corren a la vez: cada una solo termina cuando
// la otra ya ha empezado. En serie, la primera no volvería nunca.
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
			t.Fatal("waitAll = true con una espera vencida")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("las esperas del cierre no corren en paralelo")
	}
}

func TestWaitAllTrueWhenAllFinish(t *testing.T) {
	if !waitAll(func() bool { return true }, func() bool { return true }) {
		t.Fatal("waitAll = false con todas las esperas a tiempo")
	}
	if !waitAll() {
		t.Fatal("waitAll() sin esperas = false")
	}
}
