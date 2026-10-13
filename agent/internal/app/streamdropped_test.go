package app

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"mcsm/agent/internal/logs"
)

func TestPumpSendsStreamDroppedWithTheDifference(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	lines := make(chan logs.Line)
	tick := make(chan time.Time)
	var dropped atomic.Uint64
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.pump(ctx, 7, "a", lines, dropped.Load, tick, s.send)
		close(done)
	}()
	tick <- time.Now() // without drops: nothing is sent
	dropped.Store(5)
	tick <- time.Now()
	if e := s.next(t); e.StreamId != 7 || e.GetStreamDropped().GetCount() != 5 {
		t.Fatalf("notice = %+v", e)
	}
	lines <- logs.Line{TS: time.UnixMilli(1_000), Text: "hola"}
	if e := s.next(t); e.StreamId != 7 || e.GetLogLine().GetLine() != "hola" {
		t.Fatalf("line = %+v", e)
	}
	dropped.Store(7)
	tick <- time.Now()
	if e := s.next(t); e.GetStreamDropped().GetCount() != 2 {
		t.Fatalf("only the difference: %+v", e)
	}
	tick <- time.Now() // without new drops: nothing
	cancel()
	<-done
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.envs) != 3 {
		t.Fatalf("messages = %d: %+v", len(s.envs), s.envs)
	}
}
