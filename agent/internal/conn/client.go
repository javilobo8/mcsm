package conn

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

var ErrNotConnected = errors.New("conn: sin conexión con el panel")

const (
	readLimit   = 4 << 20
	pingEvery   = 15 * time.Second
	pingTimeout = 10 * time.Second
	sendTimeout = 10 * time.Second
	dialTimeout = 15 * time.Second
)

// Handler procesa los mensajes del panel. Se invoca en una goroutine por
// mensaje, por lo que no hay garantía de orden entre mensajes.
type Handler interface {
	Handle(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error)
}

type HelloFunc func(ctx context.Context) *mcsmv1.Hello

type Options struct {
	PanelURL     string
	Token        string
	Hello        HelloFunc
	Handler      Handler
	OnDisconnect func()
	// OnAuthRejected se invoca cuando el panel rechaza el token (401/403) en el handshake.
	OnAuthRejected func()
	Log            *slog.Logger
}

type Client struct {
	opts        Options
	log         *slog.Logger
	backoffMin  time.Duration
	backoffMax  time.Duration
	pingEvery   time.Duration
	stableAfter time.Duration
	after       func(time.Duration) <-chan time.Time
	ping        func(context.Context, *websocket.Conn) error

	mu        sync.Mutex // protege solo el puntero ws; coder/websocket serializa las escrituras
	ws        *websocket.Conn
	connected atomic.Bool
}

func NewClient(o Options) *Client {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Client{opts: o, log: o.Log.With("component", "conn"),
		backoffMin: time.Second, backoffMax: 30 * time.Second, pingEvery: pingEvery, stableAfter: 30 * time.Second,
		after: time.After, ping: func(ctx context.Context, ws *websocket.Conn) error { return ws.Ping(ctx) }}
}

func (c *Client) Connected() bool { return c.connected.Load() }

// Send escribe un mensaje binario por la sesión actual. Es seguro para uso
// concurrente (coder/websocket permite múltiples escritores).
func (c *Client) Send(ctx context.Context, env *mcsmv1.Envelope) error {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return ErrNotConnected
	}
	return writeEnv(ctx, ws, env)
}

func writeEnv(ctx context.Context, ws *websocket.Conn, env *mcsmv1.Envelope) error {
	raw, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	return ws.Write(wctx, websocket.MessageBinary, raw)
}

// nextBackoff duplica la espera hasta el máximo.
func nextBackoff(wait, max time.Duration) time.Duration {
	wait *= 2
	if wait > max {
		return max
	}
	return wait
}

// jittered aplica ±20 % de variación a la espera.
func jittered(wait time.Duration) time.Duration {
	return time.Duration(float64(wait) * (0.8 + 0.4*rand.Float64()))
}

// Run mantiene la sesión viva hasta que ctx termina.
func (c *Client) Run(ctx context.Context) {
	wait := c.backoffMin
	for {
		res, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		// solo se considera sana una sesión que recibió algo del panel o que
		// duró lo suficiente; si no, un panel que acepta y corta provocaría
		// reintentos cada ~1 s para siempre
		if res.gotFrame || res.lasted >= c.stableAfter {
			wait = c.backoffMin
		}
		d := jittered(wait)
		switch {
		case res.authRejected:
			c.log.Info("reintentando alta de sesión tras rechazo de token", "reintento_en", d)
		case !res.established:
			c.log.Warn("no se pudo conectar con el panel", "err", err, "reintento_en", d)
		default:
			c.log.Warn("sesión con el panel terminada", "err", err, "reintento_en", d)
		}
		select {
		case <-ctx.Done():
			return
		case <-c.after(d):
		}
		wait = nextBackoff(wait, c.backoffMax)
	}
}

func wsURL(panelURL string) string {
	u := strings.TrimRight(panelURL, "/")
	u = strings.Replace(u, "http://", "ws://", 1)
	u = strings.Replace(u, "https://", "wss://", 1)
	return u + "/agent/ws"
}

type sessionResult struct {
	established  bool          // Hello enviado
	gotFrame     bool          // el panel envió al menos un frame
	authRejected bool          // 401/403 en el handshake
	lasted       time.Duration // duración desde que se estableció
}

func (c *Client) session(ctx context.Context) (res sessionResult, err error) {
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	ws, resp, err := websocket.Dial(dctx, wsURL(c.opts.PanelURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.opts.Token}},
	})
	cancel()
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			res.authRejected = true
			c.log.Warn("el panel rechazó el token del nodo", "status", resp.StatusCode) // el Error con instrucciones lo emite OnAuthRejected
			if c.opts.OnAuthRejected != nil {
				c.opts.OnAuthRejected()
			}
		}
		return res, err
	}
	ws.SetReadLimit(readLimit)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	// el Hello va directo sobre el ws nuevo, antes de publicarlo: ningún Send
	// concurrente puede adelantarlo
	if err := writeEnv(sctx, ws, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_Hello{Hello: c.opts.Hello(sctx)}}); err != nil {
		_ = ws.Close(websocket.StatusInternalError, "hello")
		return res, err
	}
	res.established = true
	start := time.Now()

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()
	c.connected.Store(true)
	defer func() {
		stop()
		c.connected.Store(false)
		c.mu.Lock()
		if c.ws == ws {
			c.ws = nil
		}
		c.mu.Unlock()
		_ = ws.Close(websocket.StatusNormalClosure, "bye")
		res.lasted = time.Since(start)
		if c.opts.OnDisconnect != nil {
			c.opts.OnDisconnect()
		}
	}()
	c.log.Info("conectado al panel", "url", c.opts.PanelURL)

	go func() {
		t := time.NewTicker(c.pingEvery)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				pctx, pc := context.WithTimeout(sctx, pingTimeout)
				err := c.ping(pctx, ws)
				pc()
				if err != nil {
					if sctx.Err() == nil {
						c.log.Warn("ping fallido", "err", err)
						_ = ws.CloseNow() // par muerto: no tiene sentido esperar el handshake de cierre
					}
					return
				}
			}
		}
	}()

	// send queda ligado a ESTA sesión: tras reconectar, una respuesta tardía
	// no puede salir por la sesión nueva
	send := func(e *mcsmv1.Envelope) error {
		if sctx.Err() != nil {
			return ErrNotConnected
		}
		return writeEnv(sctx, ws, e)
	}
	for {
		_, data, err := ws.Read(sctx)
		if err != nil {
			return res, err
		}
		res.gotFrame = true
		env := &mcsmv1.Envelope{}
		if err := proto.Unmarshal(data, env); err != nil {
			c.log.Warn("mensaje inválido", "err", err)
			continue
		}
		go c.dispatch(sctx, env, send)
	}
}

func (c *Client) dispatch(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("panic en el handler", "panic", r, "stack", string(debug.Stack()))
		}
	}()
	c.opts.Handler.Handle(ctx, env, send)
}
