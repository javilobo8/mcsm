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

// startStream abre un stream de logs y espera a que el follower esté suscrito
// reescribiendo una línea hasta que llega (el fake descarta líneas sin lector).
func startStream(t *testing.T, a *App, fake *docker.Fake, s *sink, ctx context.Context, id uint64, serverID string) *logStream {
	t.Helper()
	a.Handle(ctx, &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: serverID, Tail: 50}}}, s.send)
	ack := s.next(t)
	if ack.Id != id || ack.StreamId != id || ack.GetAck() == nil {
		t.Fatalf("ack = %+v", ack)
	}
	a.mu.Lock()
	ls := a.streams[id]
	a.mu.Unlock()
	if ls == nil {
		t.Fatal("stream no registrado")
	}
	cid := a.rec.ContainerID(ctx, serverID)
	deadline := time.After(3 * time.Second)
	for {
		fake.WriteLog(cid, "2026-10-12T10:00:00Z Done!\n")
		select {
		case e := <-s.ch:
			if e.GetLogLine() != nil {
				if e.StreamId != id || e.GetLogLine().Line != "Done!" || e.GetLogLine().ServerId != serverID {
					t.Fatalf("line = %+v", e)
				}
				return ls
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("el stream no entregó líneas")
		}
	}
}

func waitDone(t *testing.T, ls *logStream) {
	t.Helper()
	select {
	case <-ls.done:
	case <-time.After(3 * time.Second):
		t.Fatal("la goroutine del stream no terminó")
	}
}

// noMoreLogLines vacía lo ya enviado y comprueba que una línea nueva no llega.
func noMoreLogLines(t *testing.T, s *sink, fake *docker.Fake, cid string) {
	t.Helper()
	for len(s.ch) > 0 {
		<-s.ch
	}
	fake.WriteLog(cid, "2026-10-12T10:00:01Z Tarde\n")
	select {
	case e := <-s.ch:
		if e.GetLogLine() != nil {
			t.Fatalf("no deben salir LogLine tras cerrar: %+v", e)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func applyAndWait(t *testing.T, a *App, s *sink, id, slug string) {
	t.Helper()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg(id, slug, 1)}}}, s.send)
	s.waitID(t, 1)
}

func TestSubscribeLogsStream(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applyAndWait(t, a, s, "a", "alpha")
	ls := startStream(t, a, fake, s, ctx, 5, "a")
	a.Handle(ctx, &mcsmv1.Envelope{StreamId: 5, Body: &mcsmv1.Envelope_StreamClose{StreamClose: &mcsmv1.StreamClose{}}}, s.send)
	waitDone(t, ls)
	a.mu.Lock()
	_, open := a.streams[5]
	a.mu.Unlock()
	if open {
		t.Fatal("StreamClose debe cancelar el stream")
	}
	noMoreLogLines(t, s, fake, a.rec.ContainerID(ctx, "a"))
}

func TestCancelAllStreamsStopsGoroutinesAndLines(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	applyAndWait(t, a, s, "a", "alpha")
	ls := startStream(t, a, fake, s, ctx, 5, "a")
	a.cancelAllStreams()
	waitDone(t, ls)
	noMoreLogLines(t, s, fake, a.rec.ContainerID(ctx, "a"))
}

func TestSubscribeLogsUnknownServer(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_SubscribeLogs{SubscribeLogs: &mcsmv1.SubscribeLogs{ServerId: "nope"}}}, s.send)
	e := s.next(t)
	if e.Id != 5 || e.GetError() == nil || e.GetError().Code != "unknown_server" {
		t.Fatalf("resp = %+v", e)
	}
	a.mu.Lock()
	n := len(a.streams)
	a.mu.Unlock()
	if n != 0 {
		t.Fatal("no debe abrir stream")
	}
}

func TestUnsupportedMessageWithIDGetsError(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 12, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}, s.send)
	e := s.next(t)
	if e.Id != 12 || e.GetError() == nil || e.GetError().Code != "unsupported" {
		t.Fatalf("resp = %+v", e)
	}
}

func TestApplySpecKeepsNewerButSyncSpecsOverrides(t *testing.T) {
	a, _, st := newApp(t)
	s := newSink()
	ctx := context.Background()
	apply := func(id uint64, v uint64) {
		a.Handle(ctx, &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", v)}}}, s.send)
		s.waitID(t, id)
	}
	apply(1, 2)
	apply(2, 1)
	if sp, _ := st.GetSpec("a"); sp.Version != 2 {
		t.Fatalf("ApplySpec v1 tras v2 debe ignorarse, version=%d", sp.Version)
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}}}}, s.send)
	s.waitID(t, 3)
	if sp, _ := st.GetSpec("a"); sp.Version != 1 {
		t.Fatalf("SyncSpecs es la verdad del panel, version=%d", sp.Version)
	}
}

func TestPowerAction(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "nope", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "power_failed" {
		t.Fatalf("resp = %+v", e)
	}
	applyAndWait(t, a, s, "a", "alpha")
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
}

func TestSendCommandErrors(t *testing.T) {
	a, _, st := newApp(t)
	s := newSink()
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "nope", Command: "x"}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "unknown_server" {
		t.Fatalf("resp = %+v", e)
	}
	_ = st.PutSpec(specMsg("a", "alpha", 1))
	a.rcon = func(context.Context, string, uint16, string, string) (string, error) {
		return "", context.DeadlineExceeded
	}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "x"}}}, s.send)
	if e := s.next(t); e.GetError() == nil || e.GetError().Code != "rcon_failed" {
		t.Fatalf("resp = %+v", e)
	}
}

// Un servidor bloqueado en una operación larga no debe frenar la observación de los demás.
func TestBlockedServerDoesNotStallOthers(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	slowSpec := specMsg("slow", "slow", 1)
	fastSpec := specMsg("fast", "fast", 1)
	for i, sp := range []*mcsmv1.ServerSpec{slowSpec, fastSpec} {
		a.Handle(ctx, &mcsmv1.Envelope{Id: uint64(i + 1), Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
		s.waitID(t, uint64(i+1))
	}
	// Ports distintos no importan: el fake solo choca al arrancar y ambos ya están en marcha o fallaron.
	release := make(chan struct{})
	entered := make(chan struct{}, 8)
	a.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		if host == "mcsm-slow" {
			entered <- struct{}{}
			<-release
		}
		return &mcsmv1.McStatus{Online: true}
	}
	defer close(release)
	go a.eventLoop(ctx)
	slowEv := docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "slow"}}
	fastEv := docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "fast"}}
	deadline := time.After(3 * time.Second)
	slowIn := false
	for {
		fake.EmitEvent(slowEv)
		if slowIn {
			fake.EmitEvent(fastEv)
		}
		select {
		case <-entered:
			slowIn = true
		case e := <-s.ch:
			if o := e.GetServerObserved(); o != nil && o.ServerId == "fast" && slowIn {
				return
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatalf("slowIn=%v: el servidor lento bloquea al resto", slowIn)
		}
	}
}

func TestEventTriggersObserve(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applyAndWait(t, a, s, "a", "alpha")
	go a.eventLoop(ctx)
	deadline := time.After(3 * time.Second)
	for {
		fake.EmitEvent(docker.Event{Action: "die", Labels: map[string]string{"mcsm.server_id": "a"}})
		select {
		case e := <-s.ch:
			if e.GetServerObserved() != nil {
				return
			}
		case <-time.After(10 * time.Millisecond):
		case <-deadline:
			t.Fatal("el evento no provocó Observe")
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

func TestLoadConfigValidation(t *testing.T) {
	t.Setenv("PANEL_URL", "panel:3000")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("PANEL_URL sin esquema http/https debe fallar")
	}
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("DATA_ROOT", "relativa/ruta")
	if _, err := LoadConfig("x"); err == nil {
		t.Fatal("DATA_ROOT relativa debe fallar")
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
