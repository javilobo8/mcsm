package app

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestOutboxDropWarningNamesItsQueue(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, nil))
	delivered := make(chan struct{}, 1)
	o := newOutbox(func(*mcsmv1.Envelope) error { delivered <- struct{}{}; return nil }, 1, log, "events for the panel")
	if err := o.post(&mcsmv1.Envelope{}); err != nil {
		t.Fatal(err)
	}
	if err := o.post(&mcsmv1.Envelope{}); err == nil {
		t.Fatal("with the queue full it is dropped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go o.run(ctx)
	<-delivered
	mark := make(chan struct{})
	o.ch <- outItem{mark: mark}
	<-mark // the drop notice is written after delivering, before the mark
	got := buf.String()
	if !strings.Contains(got, "events for the panel") || strings.Contains(got, "backups") {
		t.Fatalf("log = %q", got)
	}
}
