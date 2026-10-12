package app

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/store"
)

const specJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh"}`

type sink struct {
	mu   sync.Mutex
	envs []*mcsmv1.Envelope
	ch   chan *mcsmv1.Envelope
}

func newSink() *sink { return &sink{ch: make(chan *mcsmv1.Envelope, 64)} }

func (s *sink) send(e *mcsmv1.Envelope) error {
	s.mu.Lock()
	s.envs = append(s.envs, e)
	s.mu.Unlock()
	s.ch <- e
	return nil
}

func (s *sink) next(t *testing.T) *mcsmv1.Envelope {
	t.Helper()
	select {
	case e := <-s.ch:
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("sin respuesta")
		return nil
	}
}

// waitID descarta mensajes hasta recibir la respuesta con ese id.
func (s *sink) waitID(t *testing.T, id uint64) *mcsmv1.Envelope {
	t.Helper()
	for {
		if e := s.next(t); e.Id == id {
			return e
		}
	}
}

func newApp(t *testing.T) (*App, *docker.Fake, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	cfg := Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}
	a := New(cfg, st, fake, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	return a, fake, st
}

func specMsg(id, slug string, v uint64) *mcsmv1.ServerSpec {
	return &mcsmv1.ServerSpec{ServerId: id, Slug: slug, Version: v, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(specJSON)}
}

func TestSyncSpecsAndObserved(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}}}}, s.send)
	var sawObserved, sawAck bool
	// Apply y ReconcileAll pueden emitir varios ServerObserved antes del Ack.
	for !sawObserved || !sawAck {
		e := s.next(t)
		if e.GetServerObserved() != nil && e.GetServerObserved().ServerId == "a" && e.GetServerObserved().Observed.State == "running" {
			sawObserved = true
		}
		if e.Id == 7 && e.GetAck() != nil {
			sawAck = true
		}
	}
	if !sawObserved || !sawAck {
		t.Fatalf("observed=%v ack=%v", sawObserved, sawAck)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 {
		t.Fatal("debe haber creado el contenedor")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("la spec debe quedar en el store")
	}
	// removed_ids borra contenedor y spec
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 8, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{RemovedIds: []string{"a"}}}}, s.send)
	s.waitID(t, 8)
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("debe haber borrado el contenedor")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("la spec debe borrarse")
	}
}

func TestApplySpecErrorIsReported(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	fake.CreateErr = context.DeadlineExceeded
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	e := s.waitID(t, 9)
	if e.GetError() == nil || e.GetError().Code != "apply_failed" {
		t.Fatalf("resp = %+v", e)
	}
}

func TestApplySpecInvalidSlugRejected(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "../etc", 1)}}}, s.send)
	e := s.waitID(t, 3)
	if e.GetError() == nil || e.GetError().Code != "invalid_spec" {
		t.Fatalf("resp = %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("no debe crear contenedores")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("no debe guardar la spec")
	}
}

func TestRemoveServerDeletesContainerAndSpec(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	s.waitID(t, 1)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: "a"}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 0 {
		t.Fatal("contenedor no borrado")
	}
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("spec no borrada")
	}
}

func TestSendCommandUsesRcon(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 1))
	var gotHost, gotPw, gotCmd string
	var gotPort uint16
	a.rcon = func(_ context.Context, host string, port uint16, pw, cmd string) (string, error) {
		gotHost, gotPort, gotPw, gotCmd = host, port, pw, cmd
		return "ok", nil
	}
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 4, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "list"}}}, s.send)
	e := s.waitID(t, 4)
	if e.GetCommandResult() == nil || e.GetCommandResult().Output != "ok" {
		t.Fatalf("resp = %+v", e)
	}
	if gotHost != "mcsm-alpha" || gotPort != 25575 || gotPw != "abcdefgh" || gotCmd != "list" {
		t.Fatalf("rcon args: %s %d %s %s", gotHost, gotPort, gotPw, gotCmd)
	}
}

func TestSubscribeLogsStream(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	s.waitID(t, 1)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: "a", Tail: 50}}}, s.send)
	ack := s.next(t)
	if ack.Id != 5 || ack.StreamId != 5 || ack.GetAck() == nil {
		t.Fatalf("ack = %+v", ack)
	}
	time.Sleep(30 * time.Millisecond)
	id := a.rec.ContainerID(ctx, "a")
	fake.WriteLog(id, "2026-10-12T10:00:00Z Done!\n")
	for {
		e := s.next(t)
		if e.GetLogLine() != nil {
			if e.StreamId != 5 || e.GetLogLine().Line != "Done!" || e.GetLogLine().ServerId != "a" {
				t.Fatalf("line = %+v", e)
			}
			break
		}
	}
	a.Handle(ctx, &mcsmv1.Envelope{StreamId: 5, Body: &mcsmv1.Envelope_StreamClose{StreamClose: &mcsmv1.StreamClose{}}}, s.send)
	time.Sleep(20 * time.Millisecond)
	a.mu.Lock()
	_, open := a.streams[5]
	a.mu.Unlock()
	if open {
		t.Fatal("StreamClose debe cancelar el stream")
	}
}

func TestCancelAllStreams(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: "x"}}}, s.send)
	s.next(t)
	a.cancelAllStreams()
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.mu.Lock()
		n := len(a.streams)
		a.mu.Unlock()
		if n == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("streams sin cancelar")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEventTriggersObserve(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	s.waitID(t, 1)
	go a.eventLoop(ctx)
	time.Sleep(50 * time.Millisecond)
	fake.EmitEvent(docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "a"}})
	for {
		if s.next(t).GetServerObserved() != nil {
			return
		}
	}
}

func TestHelloCarriesVersions(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 4))
	h := a.hello(context.Background())
	if h.SpecVersions["a"] != 4 || h.AgentVersion != "test" {
		t.Fatalf("hello = %+v", h)
	}
}

func TestLoadConfigRequiresPanelURL(t *testing.T) {
	t.Setenv("PANEL_URL", "")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("debe exigir PANEL_URL")
	}
	t.Setenv("PANEL_URL", "http://p")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.DataRoot != "/srv/minecraft" || cfg.Network != "mcsm" {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
}
