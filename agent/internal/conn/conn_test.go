package conn

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	case <-time.After(3 * time.Second):
		t.Fatal("sin Hello")
	}
	if hello.AgentVersion != "0.1.0" || hello.SpecVersions["a"] != 3 {
		t.Fatalf("hello = %+v", hello)
	}
	ws := <-fp.ws
	if !c.Connected() {
		t.Fatal("debería estar conectado")
	}

	// panel → agente: PowerAction; el handler responde Ack con el mismo id
	req := &mcsmv1.Envelope{Id: 42, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a"}}}
	raw, _ := proto.Marshal(req)
	if err := ws.Write(ctx, websocket.MessageBinary, raw); err != nil {
		t.Fatal(err)
	}
	rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
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
	case <-time.After(3 * time.Second):
		t.Fatal("no reconectó")
	}
	if atomic.LoadInt32(&fp.conns) < 2 {
		t.Fatalf("conns = %d", fp.conns)
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
		rctx, rc := context.WithTimeout(ctx, 3*time.Second)
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
	<-fp.ws
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
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
