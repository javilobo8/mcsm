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
	o := newOutbox(func(*mcsmv1.Envelope) error { delivered <- struct{}{}; return nil }, 1, log, "eventos para el panel")
	if err := o.post(&mcsmv1.Envelope{}); err != nil {
		t.Fatal(err)
	}
	if err := o.post(&mcsmv1.Envelope{}); err == nil {
		t.Fatal("con la cola llena se descarta")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go o.run(ctx)
	<-delivered
	mark := make(chan struct{})
	o.ch <- outItem{mark: mark}
	<-mark // el aviso del descarte se escribe tras entregar, antes de la marca
	got := buf.String()
	if !strings.Contains(got, "eventos para el panel") || strings.Contains(got, "copias") {
		t.Fatalf("log = %q", got)
	}
}
