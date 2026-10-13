package app

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
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
	fake := docker.NewFake()
	a, st := newAppEngine(t, fake)
	return a, fake, st
}

// newAppEngine construye la App sobre un Engine cualquiera (envoltorios del fake).
func newAppEngine(t *testing.T, eng docker.Engine) (*App, *store.Store) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}
	a := New(cfg, st, eng, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	// Las tareas de fondo terminan antes de cerrar el store.
	t.Cleanup(a.bg.Wait)
	return a, st
}

// waitBackground espera a que terminen las tareas de fondo (sincronización y despachos).
func waitBackground(t *testing.T, a *App) {
	t.Helper()
	done := make(chan struct{})
	go func() { a.bg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("las tareas de fondo no terminaron")
	}
}

// runEventLoop arranca el bucle de eventos y, al acabar el test, lo para y espera a que salga. La limpieza se
// registra después que la de newApp, así que corre antes de su bg.Wait: un dispatch del bucle (bg.Add) a la vez
// que ese Wait es una carrera.
func runEventLoop(t *testing.T, a *App) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.eventLoop(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
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
	// El Ack sale tras guardar la spec; la reconciliación (y sus ServerObserved) va en segundo plano.
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
	if sp, _ := st.GetSpec("a"); sp != nil {
		t.Fatal("la spec retirada se borra antes del Ack")
	}
	waitBackground(t, a)
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

// Proto3 rechaza string con UTF-8 inválido: sin sanear, proto.Marshal falla y la línea
// (o la respuesta del comando) se pierde en silencio.
func TestLogLineAndCommandResultAreValidUTF8(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	applyAndWait(t, a, s, "a", "alpha")
	startStream(t, a, fake, s, ctx, 5, "a")
	fake.WriteLog(a.rec.ContainerID(ctx, "a"), "2026-10-12T10:00:02Z caf\xc3 \xff fin\n")
	for {
		e := s.next(t)
		if ll := e.GetLogLine(); ll != nil {
			if !utf8.ValidString(ll.Line) || ll.Line != "caf\uFFFD \uFFFD fin" {
				t.Fatalf("línea = %q", ll.Line)
			}
			if _, err := proto.Marshal(e); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	a.rcon = func(context.Context, string, uint16, string, string) (string, error) { return "ok \xfe", nil }
	a.Handle(ctx, &mcsmv1.Envelope{Id: 40, Body: &mcsmv1.Envelope_SendCommand{SendCommand: &mcsmv1.SendCommand{ServerId: "a", Command: "list"}}}, s.send)
	e := s.waitID(t, 40)
	if out := e.GetCommandResult().GetOutput(); out != "ok \uFFFD" {
		t.Fatalf("output = %q", out)
	}
	if _, err := proto.Marshal(e); err != nil {
		t.Fatal(err)
	}
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

// Un panel más nuevo puede enviar un cuerpo que este agente no conoce: protobuf lo deja
// en campos desconocidos y Body llega nil. Se responde unsupported pidiendo actualizar.
func TestUnknownBodyGetsUnsupportedError(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	raw := protowire.AppendTag(nil, 1, protowire.VarintType)
	raw = protowire.AppendVarint(raw, 12)
	raw = protowire.AppendTag(raw, 99, protowire.BytesType) // campo del oneof que este agente no tiene
	raw = protowire.AppendBytes(raw, []byte{0x0a, 0x01, 'x'})
	env := &mcsmv1.Envelope{}
	if err := proto.Unmarshal(raw, env); err != nil || env.Body != nil {
		t.Fatalf("env = %+v err = %v", env, err)
	}
	a.Handle(context.Background(), env, s.send)
	e := s.next(t)
	if e.Id != 12 || e.GetError() == nil || e.GetError().Code != errcode.Unsupported || !strings.Contains(e.GetError().Message, "actualiza el agente") {
		t.Fatalf("resp = %+v", e)
	}
}

// Ack y Error del panel nunca se contestan: el agente no hace peticiones y responder a
// un Error con otro Error podría encadenar un bucle.
func TestAckAndErrorFromPanelAreNotAnswered(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 12, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}, s.send)
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 13, Body: &mcsmv1.Envelope_Error{Error: &mcsmv1.Error{Code: "x", Message: "y"}}}, s.send)
	select {
	case e := <-s.ch:
		t.Fatalf("no debe responder: %+v", e)
	case <-time.After(50 * time.Millisecond):
	}
}

// Un cuerpo conocido pero que el panel no debe enviar (Hello) se rechaza como no soportado.
func TestUnexpectedKnownBodyGetsUnsupported(t *testing.T) {
	a, _, _ := newApp(t)
	s := newSink()
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 14, Body: &mcsmv1.Envelope_Hello{Hello: &mcsmv1.Hello{}}}, s.send)
	if e := s.next(t); e.Id != 14 || e.GetError().GetCode() != errcode.Unsupported {
		t.Fatalf("resp = %+v", e)
	}
}

func syncMsg(id uint64, servers []*mcsmv1.ServerSpec, removed ...string) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_SyncSpecs{SyncSpecs: &mcsmv1.SyncSpecs{Servers: servers, RemovedIds: removed}}}
}

func applyMsg(id uint64, sp *mcsmv1.ServerSpec) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}
}

func withMemory(sp *mcsmv1.ServerSpec, mem string) *mcsmv1.ServerSpec {
	sp.SpecJson = []byte(strings.Replace(specJSON, `"memory":"2G"`, `"memory":"`+mem+`"`, 1))
	return sp
}

// containerEnv lee el env del contenedor del servidor. Solo tras waitBackground: sin
// tareas de fondo vivas nadie más toca el fake.
func containerEnv(t *testing.T, fake *docker.Fake, serverID string) map[string]string {
	t.Helper()
	list, _ := fake.ListManaged(context.Background())
	for _, c := range list {
		if c.Labels["mcsm.server_id"] == serverID {
			env := fake.Containers[c.ID].Config.Env
			m := map[string]string{}
			for _, kv := range env {
				k, v, _ := strings.Cut(kv, "=")
				m[k] = v
			}
			return m
		}
	}
	t.Fatalf("sin contenedor para %s", serverID)
	return nil
}

// Dentro de una sesión, la guarda de versión sigue aplicando entre ApplySpecs: un
// ApplySpec v6 posterior a un SyncSpecs v5 gana, y uno v4 se ignora.
func TestApplySpecAfterSyncSpecsKeepsNewer(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 5)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	a.Handle(ctx, applyMsg(2, withMemory(specMsg("a", "alpha", 6), "3G")), s.send)
	s.waitID(t, 2)
	a.Handle(ctx, applyMsg(3, withMemory(specMsg("a", "alpha", 4), "4G")), s.send)
	s.waitID(t, 3)
	waitBackground(t, a)
	if sp, _ := st.GetSpec("a"); sp.Version != 6 {
		t.Fatalf("version = %d, want 6", sp.Version)
	}
	if v, _ := st.Applied("a"); v != 6 {
		t.Fatalf("applied = %d, want 6", v)
	}
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "3G" {
		t.Fatalf("el contenedor debe quedar con la spec v6, MEMORY=%s", mem)
	}
}

// En una sesión nueva, SyncSpecs fuerza la foto del panel aunque sea más antigua que
// la del store (base de datos del panel restaurada).
func TestSyncSpecsForcesOlderSpecOnNewSession(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	if err := st.PutSpec(withMemory(specMsg("a", "alpha", 6), "3G")); err != nil {
		t.Fatal(err)
	}
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 5)}), s.send)
	s.waitID(t, 1)
	if sp, _ := st.GetSpec("a"); sp.Version != 5 {
		t.Fatalf("SyncSpecs es la verdad del panel, version=%d", sp.Version)
	}
	waitBackground(t, a)
	if v, _ := st.Applied("a"); v != 5 {
		t.Fatalf("applied = %d, want 5", v)
	}
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "2G" {
		t.Fatalf("MEMORY=%s, want 2G", mem)
	}
}

// gateEngine bloquea EnsureImage hasta que se cierra gate.
type gateEngine struct {
	*docker.Fake
	gate chan struct{}
}

func (e gateEngine) EnsureImage(ctx context.Context, ref string) error {
	select {
	case <-e.gate:
	case <-ctx.Done():
		return ctx.Err()
	}
	return e.Fake.EnsureImage(ctx, ref)
}

// El Ack de SyncSpecs no espera a Docker: el panel no retiene nada durante un pull.
func TestSyncSpecsAcksBeforeTouchingDocker(t *testing.T) {
	fake := docker.NewFake()
	gate := make(chan struct{})
	a, st := newAppEngine(t, gateEngine{fake, gate})
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("a", "alpha", 1)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("la spec se guarda antes del Ack")
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatal("el contenedor aún no puede existir: el pull está bloqueado")
	}
	close(gate)
	waitBackground(t, a)
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("tras el pull debe crearse y arrancar: %+v", list)
	}
}

// Un slug borrado y recreado con el nodo desconectado: removed_ids se procesa antes,
// así que el Create del servidor nuevo no choca con el nombre del contenedor viejo.
func TestSyncSpecsReusedSlugAfterOfflineDelete(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("old", "alpha", 1)), s.send)
	s.waitID(t, 1)
	a.Handle(ctx, syncMsg(2, []*mcsmv1.ServerSpec{specMsg("new", "alpha", 1)}, "old"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Labels["mcsm.server_id"] != "new" || list[0].State != "running" {
		t.Fatalf("debe quedar solo el contenedor nuevo en marcha: %+v (calls %v)", list, fake.Calls)
	}
	if sp, _ := st.GetSpec("old"); sp != nil {
		t.Fatal("la spec retirada no debe quedar")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.envs {
		if o := e.GetServerObserved(); o != nil && o.ServerId == "new" && o.Observed.Error != "" {
			t.Fatalf("el servidor nuevo no debe publicar errores: %s", o.Observed.Error)
		}
	}
}

func TestSyncSpecsSkipsInvalidAndStillAcks(t *testing.T) {
	a, _, st := newApp(t)
	s := newSink()
	a.send = s.send
	a.Handle(context.Background(), syncMsg(1, []*mcsmv1.ServerSpec{specMsg("bad", "../x", 1), nil, specMsg("a", "alpha", 1)}), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	if sp, _ := st.GetSpec("bad"); sp != nil {
		t.Fatal("una spec con slug inválido no se guarda")
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("las válidas sí")
	}
	waitBackground(t, a)
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
	runEventLoop(t, a)
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
	applyAndWait(t, a, s, "a", "alpha")
	runEventLoop(t, a)
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

func TestHelloCarriesVersionsAndDesiredStates(t *testing.T) {
	a, _, st := newApp(t)
	_ = st.PutSpec(specMsg("a", "alpha", 4))
	b := specMsg("b", "beta", 2)
	b.DesiredState = mcsmv1.DesiredState_DESIRED_STATE_STOPPED
	_ = st.PutSpec(b)
	h := a.hello(context.Background())
	if h.SpecVersions["a"] != 4 || h.SpecVersions["b"] != 2 || h.AgentVersion != "test" {
		t.Fatalf("hello = %+v", h)
	}
	if h.DesiredStates["a"] != mcsmv1.DesiredState_DESIRED_STATE_RUNNING || h.DesiredStates["b"] != mcsmv1.DesiredState_DESIRED_STATE_STOPPED {
		t.Fatalf("desired_states = %v", h.DesiredStates)
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

// ctxEngine imita a Moby: las operaciones fallan si el contexto está cancelado.
type ctxEngine struct{ *docker.Fake }

func (e ctxEngine) EnsureImage(ctx context.Context, ref string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.EnsureImage(ctx, ref)
}

func (e ctxEngine) ListManaged(ctx context.Context) ([]docker.Container, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return e.Fake.ListManaged(ctx)
}

func (e ctxEngine) Stop(ctx context.Context, id string, t time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.Stop(ctx, id, t)
}

func (e ctxEngine) Remove(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return e.Fake.Remove(ctx, id)
}

// Un corte de la sesión WS no debe cancelar las operaciones que mutan Docker: usan el
// contexto de vida del agente, no el de la sesión.
func TestMutatingHandlersSurviveSessionCancel(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fake := docker.NewFake()
	a := New(Config{DataRoot: filepath.Join(dir, "data"), Network: "mcsm", Version: "test"}, st, ctxEngine{fake}, slog.Default())
	a.status = func(context.Context, string, uint16) *mcsmv1.McStatus { return &mcsmv1.McStatus{Online: true} }
	s := newSink()
	a.send = s.send
	session, cancel := context.WithCancel(context.Background())
	cancel() // la sesión ya se cortó cuando el handler llega a Docker

	a.Handle(session, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("ApplySpec con la sesión cortada: %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("el contenedor debe crearse y arrancar: %+v", list)
	}
	a.Handle(session, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("PowerAction con la sesión cortada: %+v", e)
	}
	a.Handle(session, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: "a"}}}, s.send)
	if e := s.waitID(t, 3); e.GetAck() == nil {
		t.Fatalf("RemoveServer con la sesión cortada: %+v", e)
	}
	if list, _ := fake.ListManaged(context.Background()); len(list) != 0 {
		t.Fatalf("el contenedor debe borrarse: %+v", list)
	}
}

// failRemoveEngine hace fallar Remove mientras fail esté activo.
type failRemoveEngine struct {
	*docker.Fake
	mu   sync.Mutex
	fail bool
}

func (e *failRemoveEngine) setFail(v bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.fail = v
}

func (e *failRemoveEngine) Remove(ctx context.Context, id string) error {
	e.mu.Lock()
	fail := e.fail
	e.mu.Unlock()
	if fail {
		return errors.New("docker: no se pudo borrar")
	}
	return e.Fake.Remove(ctx, id)
}

// Si el borrado en segundo plano de un servidor retirado por SyncSpecs falla, el tick de
// reconciliación lo reintenta aunque su spec ya no exista (lápida del reconciliador).
func TestSyncSpecsFailedRemovalIsRetriedByTick(t *testing.T) {
	fake := docker.NewFake()
	eng := &failRemoveEngine{Fake: fake}
	a, st := newAppEngine(t, eng)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	s.waitID(t, 1)
	eng.setFail(true)
	a.Handle(ctx, syncMsg(2, nil, "a"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	if list, _ := fake.ListManaged(ctx); len(list) != 1 {
		t.Fatalf("el borrado falló: el contenedor sigue: %+v", list)
	}
	if vers, _ := st.SpecVersions(); len(vers) != 0 {
		t.Fatalf("el servidor retirado no vuelve al Hello: %v", vers)
	}
	eng.setFail(false)
	a.reconcileAll(ctx) // tick
	waitBackground(t, a)
	if list, _ := fake.ListManaged(ctx); len(list) != 0 {
		t.Fatalf("el tick debe reintentar el borrado: %+v", list)
	}
	if calls := strings.Join(fake.Calls, ";"); strings.Count(calls, "Create") != 1 {
		t.Fatalf("no debe resucitar: %v", fake.Calls)
	}
}

func powerMsg(id uint64, serverID string, act mcsmv1.PowerActionType) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: serverID, Action: act}}}
}

func removeMsg(id uint64, serverID string, deleteData bool) *mcsmv1.Envelope {
	return &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_RemoveServer{RemoveServer: &mcsmv1.RemoveServer{ServerId: serverID, DeleteData: deleteData}}}
}

// Power y Remove sobre un servidor reservado (copia o restauración en curso) responden
// busy, que el panel traduce a 409, no power_failed/remove_failed (502).
func TestPowerAndRemoveOnHeldServerAreBusy(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	if e := s.waitID(t, 1); e.GetAck() == nil {
		t.Fatalf("resp = %+v", e)
	}
	release, err := a.rec.Hold("a", "copia de seguridad")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, powerMsg(2, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP), s.send)
	if e := s.waitID(t, 2); e.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Power reservado = %+v, want busy", e)
	}
	a.Handle(ctx, removeMsg(3, "a", false), s.send)
	if e := s.waitID(t, 3); e.GetError().GetCode() != errcode.Busy {
		t.Fatalf("Remove reservado = %+v, want busy", e)
	}
	if sp, _ := st.GetSpec("a"); sp == nil {
		t.Fatal("la spec sigue")
	}
	if list, _ := fake.ListManaged(ctx); len(list) != 1 || list[0].State != "running" {
		t.Fatalf("el contenedor no se toca: %+v", list)
	}
	release(ctx)
	a.Handle(ctx, powerMsg(4, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP), s.send)
	if e := s.waitID(t, 4); e.GetAck() == nil {
		t.Fatalf("tras liberar, Power = %+v", e)
	}
}

// ApplySpec con el servidor reservado no falla: guarda la spec, responde Ack y la aplica
// al liberar la reserva.
func TestApplySpecOnHeldServerIsDeferred(t *testing.T) {
	a, fake, st := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("a", "alpha", 1)), s.send)
	s.waitID(t, 1)
	release, err := a.rec.Hold("a", "restauración")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(ctx, applyMsg(2, withMemory(specMsg("a", "alpha", 2), "3G")), s.send)
	if e := s.waitID(t, 2); e.GetAck() == nil {
		t.Fatalf("ApplySpec reservado = %+v, want Ack", e)
	}
	waitBackground(t, a)
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "2G" {
		t.Fatalf("durante la reserva no se recrea: MEMORY=%s", mem)
	}
	release(ctx)
	if mem := containerEnv(t, fake, "a")["MEMORY"]; mem != "3G" {
		t.Fatalf("al liberar se aplica la spec aplazada: MEMORY=%s", mem)
	}
	if v, _ := st.Applied("a"); v != 2 {
		t.Fatalf("applied = %d, want 2", v)
	}
}

// Un slug retirado (con su contenedor aún por borrar) y recreado con otro id: el tick borra
// primero el contenedor viejo y después reconcilia el nuevo, que no choca con el nombre
// ni cae en backoff.
func TestTickRemovesTombstonesBeforeReconciling(t *testing.T) {
	fake := docker.NewFake()
	eng := &failRemoveEngine{Fake: fake}
	a, st := newAppEngine(t, eng)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, applyMsg(1, specMsg("old", "alpha", 1)), s.send)
	s.waitID(t, 1)
	eng.setFail(true)
	a.Handle(ctx, syncMsg(2, nil, "old"), s.send)
	s.waitID(t, 2)
	waitBackground(t, a)
	eng.setFail(false)
	if err := a.rec.StoreForce(specMsg("new", "alpha", 1)); err != nil {
		t.Fatal(err)
	}
	a.reconcileAll(ctx) // tick
	waitBackground(t, a)
	list, _ := fake.ListManaged(ctx)
	if len(list) != 1 || list[0].Labels["mcsm.server_id"] != "new" || list[0].State != "running" {
		t.Fatalf("debe quedar solo el contenedor nuevo en marcha: %+v (calls %v)", list, fake.Calls)
	}
	if v, _ := st.Applied("new"); v != 1 {
		t.Fatalf("el servidor nuevo se aplica en el mismo tick: applied = %d", v)
	}
}
