package conn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestEnroll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/enroll" || r.Method != http.MethodPost {
			t.Errorf("ruta %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["enrollToken"] != "ENR" || body["nameHint"] != "nas" || body["agentVersion"] != "0.1.0" {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"nodeId": "n1", "nodeToken": "TOK"})
	}))
	defer srv.Close()
	res, err := Enroll(context.Background(), srv.URL, "ENR", "nas", "0.1.0")
	if err != nil || res.NodeID != "n1" || res.NodeToken != "TOK" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if _, err := Enroll(context.Background(), srv.URL, "BAD", "nas", "0.1.0"); err == nil {
		t.Fatal("token inválido debe fallar")
	}
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// hangGuard solo evita que un fallo cuelgue la suite: no forma parte de lo que
// se comprueba, así que es holgado para máquinas cargadas.
const hangGuard = 10 * time.Second

// waitFor espera a que cond se cumpla, sondeando.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	deadline := time.After(hangGuard)
	for !cond() {
		select {
		case <-tick.C:
		case <-deadline:
			t.Fatalf("timeout esperando %s", what)
		}
	}
}

// waitConnected espera a que el cliente publique la sesión. El panel recibe el
// Hello antes de que el cliente marque la sesión como conectada (el Hello se
// escribe antes de publicar el ws para que nada se le adelante), así que leer
// el Hello en el panel no garantiza que Connected/Send ya funcionen.
func waitConnected(t *testing.T, c *Client) {
	t.Helper()
	waitFor(t, "sesión publicada", c.Connected)
}

type captureHandler struct {
	mu   sync.Mutex
	envs []*mcsmv1.Envelope
}

func (h *captureHandler) Handle(_ context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	h.mu.Lock()
	h.envs = append(h.envs, env)
	h.mu.Unlock()
	if env.GetPowerAction() != nil {
		_ = send(&mcsmv1.Envelope{Id: env.Id, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}})
	}
}

// fakePanel acepta WebSockets, verifica el token, lee el Hello y deja
// que el test dirija la conversación.
type fakePanel struct {
	t        *testing.T
	srv      *httptest.Server
	conns    int32
	rejected int32
	gotHello chan *mcsmv1.Hello
	ws       chan *websocket.Conn
}

func newFakePanel(t *testing.T) *fakePanel {
	fp := &fakePanel{t: t, gotHello: make(chan *mcsmv1.Hello, 4), ws: make(chan *websocket.Conn, 4)}
	fp.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/ws" || r.Header.Get("Authorization") != "Bearer TOK" {
			atomic.AddInt32(&fp.rejected, 1)
			w.WriteHeader(401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		atomic.AddInt32(&fp.conns, 1)
		_, data, err := c.Read(r.Context())
		if err != nil {
			return
		}
		env := &mcsmv1.Envelope{}
		_ = proto.Unmarshal(data, env)
		fp.gotHello <- env.GetHello()
		fp.ws <- c
		<-r.Context().Done()
	}))
	t.Cleanup(fp.srv.Close)
	return fp
}

func TestClientHelloDispatchAndReconnect(t *testing.T) {
	fp := newFakePanel(t)
	h := &captureHandler{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := NewClient(Options{Log: quiet,
		PanelURL: fp.srv.URL, Token: "TOK", Handler: h,
		Hello: func(context.Context) *mcsmv1.Hello {
			return &mcsmv1.Hello{AgentVersion: "0.1.0", SpecVersions: map[string]uint64{"a": 3}}
		},
	})
	c.backoffMin, c.backoffMax = 10*time.Millisecond, 50*time.Millisecond
	go c.Run(ctx)

	var hello *mcsmv1.Hello
	select {
	case hello = <-fp.gotHello:
	case <-time.After(hangGuard):
		t.Fatal("sin Hello")
	}
	if hello.AgentVersion != "0.1.0" || hello.SpecVersions["a"] != 3 {
		t.Fatalf("hello = %+v", hello)
	}
	ws := <-fp.ws
	waitConnected(t, c)

	// panel → agente: PowerAction; el handler responde Ack con el mismo id
	req := &mcsmv1.Envelope{Id: 42, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a"}}}
	raw, _ := proto.Marshal(req)
	if err := ws.Write(ctx, websocket.MessageBinary, raw); err != nil {
		t.Fatal(err)
	}
	rctx, rcancel := context.WithTimeout(ctx, hangGuard)
	_, data, err := ws.Read(rctx)
	rcancel()
	if err != nil {
		t.Fatal(err)
	}
	resp := &mcsmv1.Envelope{}
	_ = proto.Unmarshal(data, resp)
	if resp.Id != 42 || resp.GetAck() == nil {
		t.Fatalf("resp = %+v", resp)
	}

	// el panel cierra: el agente debe reconectar y volver a saludar
	ws.Close(websocket.StatusGoingAway, "reinicio")
	select {
	case <-fp.gotHello:
	case <-time.After(hangGuard):
		t.Fatal("no reconectó")
	}
	if n := atomic.LoadInt32(&fp.conns); n < 2 {
		t.Fatalf("conns = %d", n)
	}
}

func TestSendWithoutConnection(t *testing.T) {
	c := NewClient(Options{Log: quiet, PanelURL: "http://127.0.0.1:1", Token: "x", Handler: &captureHandler{}, Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	if err := c.Send(context.Background(), &mcsmv1.Envelope{}); err != ErrNotConnected {
		t.Fatalf("err = %v", err)
	}
}

func TestBackoffDelay(t *testing.T) {
	min, max := time.Second, 30*time.Second
	for _, tc := range []struct{ wait time.Duration }{{time.Second}, {8 * time.Second}, {30 * time.Second}} {
		for i := 0; i < 200; i++ {
			d := jittered(tc.wait)
			lo, hi := time.Duration(float64(tc.wait)*0.8), time.Duration(float64(tc.wait)*1.2)
			if d < lo || d > hi {
				t.Fatalf("jittered(%v) = %v fuera de ±20%%", tc.wait, d)
			}
		}
	}
	w := min
	var seq []time.Duration
	for i := 0; i < 8; i++ {
		seq = append(seq, w)
		w = nextBackoff(w, max)
	}
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30, 30}
	for i := range want {
		if seq[i] != want[i]*time.Second {
			t.Fatalf("seq = %v", seq)
		}
	}
}

func TestPingKeepsSessionAndConcurrentSends(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: &captureHandler{},
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.pingEvery = 5 * time.Millisecond
	go c.Run(ctx)
	<-fp.gotHello
	ws := <-fp.ws
	waitConnected(t, c)

	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := c.Send(ctx, &mcsmv1.Envelope{Body: &mcsmv1.Envelope_LogLine{LogLine: &mcsmv1.LogLine{}}}); err != nil {
				t.Errorf("send: %v", err)
			}
		}(i)
	}
	got := 0
	for got < n {
		rctx, rc := context.WithTimeout(ctx, hangGuard)
		_, data, err := ws.Read(rctx) // Read procesa también los pings del cliente
		rc()
		if err != nil {
			t.Fatalf("read tras %d: %v", got, err)
		}
		env := &mcsmv1.Envelope{}
		if err := proto.Unmarshal(data, env); err != nil || env.GetLogLine() == nil {
			t.Fatalf("env inválido: %v %+v", err, env)
		}
		got++
	}
	wg.Wait()
	if !c.Connected() {
		t.Fatal("la sesión no debería haber caído con pings activos")
	}
}

func TestOnDisconnectAndStop(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	disc := make(chan struct{}, 4)
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: &captureHandler{},
		Hello:        func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} },
		OnDisconnect: func() { disc <- struct{}{} }})
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	<-fp.gotHello
	ws := <-fp.ws
	// Como un panel real, el lado servidor sigue leyendo y contesta al cierre.
	// Si la cancelación llega antes del primer Read del cliente, coder/websocket
	// no tumba la conexión y el Close del cliente hace el handshake completo,
	// que con un par que no lee espera 5 s a la respuesta.
	ws.CloseRead(context.Background())
	cancel()
	select {
	case <-done:
	case <-time.After(hangGuard):
		t.Fatal("Run no terminó con ctx cancelado")
	}
	select {
	case <-disc:
	default:
		t.Fatal("OnDisconnect no se llamó")
	}
	if c.Connected() {
		t.Fatal("no debería estar conectado")
	}
}

func TestBadTokenRetries(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "MALO", Handler: &captureHandler{},
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.backoffMin, c.backoffMax = time.Millisecond, 2*time.Millisecond
	go c.Run(ctx)
	for deadline := time.Now().Add(3 * time.Second); atomic.LoadInt32(&fp.rejected) < 3; {
		if time.Now().After(deadline) {
			t.Fatal("no reintentó tras el 401")
		}
		time.Sleep(time.Millisecond)
	}
	if c.Connected() || atomic.LoadInt32(&fp.conns) != 0 {
		t.Fatal("token malo no debe conectar")
	}
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func TestHelloIsAlwaysFirstFrame(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var c *Client
	c = NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: &captureHandler{},
		Hello: func(ctx context.Context) *mcsmv1.Hello {
			// un Send concurrente justo mientras se prepara el Hello no debe adelantarlo
			_ = c.Send(ctx, &mcsmv1.Envelope{Body: &mcsmv1.Envelope_LogLine{LogLine: &mcsmv1.LogLine{}}})
			return &mcsmv1.Hello{AgentVersion: "x"}
		}})
	go c.Run(ctx)
	select {
	case h := <-fp.gotHello:
		if h == nil {
			t.Fatal("el primer frame no fue el Hello")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("sin Hello")
	}
}

type sendCapture struct {
	first chan func(*mcsmv1.Envelope) error
	once  sync.Once
}

func (h *sendCapture) Handle(_ context.Context, _ *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	h.once.Do(func() { h.first <- send })
}

func TestHandlerSendBoundToItsSession(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &sendCapture{first: make(chan func(*mcsmv1.Envelope) error, 1)}
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: h,
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.backoffMin, c.backoffMax = time.Millisecond, 2*time.Millisecond
	go c.Run(ctx)
	<-fp.gotHello
	ws := <-fp.ws
	raw, _ := proto.Marshal(&mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{}}})
	_ = ws.Write(ctx, websocket.MessageBinary, raw)
	oldSend := <-h.first
	ws.Close(websocket.StatusGoingAway, "x")
	<-fp.gotHello // sesión nueva establecida
	ws2 := <-fp.ws
	waitConnected(t, c)
	if err := oldSend(&mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_Ack{Ack: &mcsmv1.Ack{}}}); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("send de sesión vieja: %v", err)
	}
	rctx, rc := context.WithTimeout(ctx, 100*time.Millisecond)
	defer rc()
	if _, _, err := ws2.Read(rctx); err == nil {
		t.Fatal("la sesión nueva recibió un frame de la vieja")
	}
}

// delayRecorder sustituye a time.After para registrar las esperas sin dormir.
type delayRecorder struct {
	mu sync.Mutex
	ds []time.Duration
	n  chan struct{}
}

func (d *delayRecorder) after(x time.Duration) <-chan time.Time {
	d.mu.Lock()
	d.ds = append(d.ds, x)
	d.mu.Unlock()
	d.n <- struct{}{}
	ch := make(chan time.Time, 1)
	ch <- time.Now()
	return ch
}

func (d *delayRecorder) collect(t *testing.T, n int) []time.Duration {
	for i := 0; i < n; i++ {
		select {
		case <-d.n:
		case <-time.After(3 * time.Second):
			t.Fatal("faltan reintentos")
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]time.Duration(nil), d.ds[:n]...)
}

func flappingPanel(t *testing.T, sendFrame bool) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		if _, _, err := c.Read(r.Context()); err != nil {
			return
		}
		if sendFrame {
			raw, _ := proto.Marshal(&mcsmv1.Envelope{Body: &mcsmv1.Envelope_HelloAck{HelloAck: &mcsmv1.HelloAck{}}})
			_ = c.Write(r.Context(), websocket.MessageBinary, raw)
		}
		c.Close(websocket.StatusPolicyViolation, "fuera")
	}))
	t.Cleanup(srv.Close)
	return srv
}

func runRecording(t *testing.T, url string, rec *delayRecorder) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := NewClient(Options{Log: quiet, PanelURL: url, Token: "TOK", Handler: &captureHandler{},
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.backoffMin, c.backoffMax = 100*time.Millisecond, time.Second
	c.after = rec.after
	go c.Run(ctx)
}

func TestBackoffNotResetWhenPanelDropsImmediately(t *testing.T) {
	rec := &delayRecorder{n: make(chan struct{}, 16)}
	runRecording(t, flappingPanel(t, false).URL, rec)
	ds := rec.collect(t, 4)
	if ds[3] < 600*time.Millisecond { // 100,200,400,800 con ±20 %
		t.Fatalf("el backoff debe crecer: %v", ds)
	}
}

func TestBackoffResetAfterPanelFrame(t *testing.T) {
	rec := &delayRecorder{n: make(chan struct{}, 16)}
	runRecording(t, flappingPanel(t, true).URL, rec)
	for _, d := range rec.collect(t, 3) {
		if d > 120*time.Millisecond {
			t.Fatalf("tras recibir un frame del panel el backoff debe reiniciarse: %v", d)
		}
	}
}

func TestAuthRejected(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	buf := &syncBuf{}
	rejected := make(chan struct{}, 8)
	c := NewClient(Options{Log: slog.New(slog.NewTextHandler(buf, nil)), PanelURL: fp.srv.URL, Token: "SECRETO", Handler: &captureHandler{},
		Hello:          func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} },
		OnAuthRejected: func() { rejected <- struct{}{} }})
	c.backoffMin, c.backoffMax = time.Millisecond, 2*time.Millisecond
	go c.Run(ctx)
	select {
	case <-rejected:
	case <-time.After(3 * time.Second):
		t.Fatal("OnAuthRejected no se llamó")
	}
	out := buf.String()
	if !strings.Contains(out, "level=WARN") || !strings.Contains(out, "rechazó el token") || strings.Contains(out, "level=ERROR") {
		t.Fatalf("log sin error claro: %s", out)
	}
	if strings.Contains(out, "SECRETO") {
		t.Fatal("el log no debe incluir el token")
	}
}

type panicHandler struct{ done chan struct{} }

func (h *panicHandler) Handle(context.Context, *mcsmv1.Envelope, func(*mcsmv1.Envelope) error) {
	close(h.done)
	panic("boom")
}

func TestHandlerPanicDoesNotCrash(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &panicHandler{done: make(chan struct{})}
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: h,
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	go c.Run(ctx)
	<-fp.gotHello
	ws := <-fp.ws
	raw, _ := proto.Marshal(&mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{}}})
	_ = ws.Write(ctx, websocket.MessageBinary, raw)
	<-h.done
	time.Sleep(10 * time.Millisecond) // deja que el panic se propague si no hay recover
	if !c.Connected() {
		t.Fatal("la sesión debería seguir viva")
	}
}

func TestPingIsSentAndFailureClosesSession(t *testing.T) {
	fp := newFakePanel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := NewClient(Options{Log: quiet, PanelURL: fp.srv.URL, Token: "TOK", Handler: &captureHandler{},
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.backoffMin, c.backoffMax = time.Millisecond, 2*time.Millisecond
	c.pingEvery = time.Millisecond
	var calls int32
	c.ping = func(context.Context, *websocket.Conn) error {
		if atomic.AddInt32(&calls, 1) == 2 {
			return errors.New("par muerto")
		}
		return nil
	}
	go c.Run(ctx)
	<-fp.gotHello
	select {
	case <-fp.gotHello: // el ping fallido tumbó la sesión y se reconectó
	case <-time.After(3 * time.Second):
		t.Fatal("no reconectó tras ping fallido")
	}
	if atomic.LoadInt32(&calls) < 2 {
		t.Fatal("no se enviaron pings")
	}
}
