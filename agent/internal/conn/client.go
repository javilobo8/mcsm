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

var ErrNotConnected = errors.New("conn: not connected to the panel")

const (
	readLimit   = 4 << 20
	pingEvery   = 15 * time.Second
	pingTimeout = 10 * time.Second
	sendTimeout = 10 * time.Second
	dialTimeout = 15 * time.Second
)

// Handler processes the panel's messages. It is invoked in one goroutine per
// message, so there is no ordering guarantee between messages.
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
	// OnAuthRejected is invoked when the panel rejects the token (401/403) in the handshake.
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

	mu        sync.Mutex // protects only the ws pointer; coder/websocket serializes writes
	ws        *websocket.Conn
	connected atomic.Bool
	tokMu     sync.Mutex // protege tok (plan-9: RotateToken lo cambia)
	tok       string
}

func NewClient(o Options) *Client {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Client{opts: o, log: o.Log.With("component", "conn"), tok: o.Token,
		backoffMin: time.Second, backoffMax: 30 * time.Second, pingEvery: pingEvery, stableAfter: 30 * time.Second,
		after: time.After, ping: func(ctx context.Context, ws *websocket.Conn) error { return ws.Ping(ctx) }}
}

func (c *Client) Connected() bool { return c.connected.Load() }

// SetToken changes the node token for subsequent sessions (plan-9: RotateToken). It does not touch the current one.
func (c *Client) SetToken(tok string) {
	c.tokMu.Lock()
	c.tok = tok
	c.tokMu.Unlock()
}

func (c *Client) token() string {
	c.tokMu.Lock()
	defer c.tokMu.Unlock()
	return c.tok
}

// Reconnect closes the current session, if any: Run reconnects (with the current token) after the minimum wait.
func (c *Client) Reconnect() {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws != nil {
		_ = ws.Close(websocket.StatusNormalClosure, "token rotated")
	}
}

// Send writes a binary message over the current session. It is safe for
// concurrent use (coder/websocket allows multiple writers).
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

// nextBackoff doubles the wait up to the maximum.
func nextBackoff(wait, max time.Duration) time.Duration {
	wait *= 2
	if wait > max {
		return max
	}
	return wait
}

// jittered applies ±20 % variation to the wait.
func jittered(wait time.Duration) time.Duration {
	return time.Duration(float64(wait) * (0.8 + 0.4*rand.Float64()))
}

// Run keeps the session alive until ctx ends.
func (c *Client) Run(ctx context.Context) {
	wait := c.backoffMin
	for {
		res, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		// a session only counts as healthy if it received something from the panel or
		// lasted long enough; otherwise a panel that accepts and hangs up would cause
		// retries every ~1 s forever
		if res.gotFrame || res.lasted >= c.stableAfter {
			wait = c.backoffMin
		}
		d := jittered(wait)
		switch {
		case res.authRejected:
			c.log.Info("retrying session enrollment after token rejection", "retry_in", d)
		case !res.established:
			c.log.Warn("could not connect to the panel", "err", err, "retry_in", d)
		default:
			c.log.Warn("session with the panel ended", "err", err, "retry_in", d)
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
	established  bool          // Hello sent
	gotFrame     bool          // the panel sent at least one frame
	authRejected bool          // 401/403 in the handshake
	lasted       time.Duration // duration since it was established
}

func (c *Client) session(ctx context.Context) (res sessionResult, err error) {
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	ws, resp, err := websocket.Dial(dctx, wsURL(c.opts.PanelURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.token()}},
	})
	cancel()
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			res.authRejected = true
			c.log.Warn("the panel rejected the node token", "status", resp.StatusCode) // the Error with instructions is emitted by OnAuthRejected
			if c.opts.OnAuthRejected != nil {
				c.opts.OnAuthRejected()
			}
		}
		return res, err
	}
	ws.SetReadLimit(readLimit)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	// the Hello goes straight over the new ws, before publishing it: no concurrent
	// Send can get ahead of it
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
	c.log.Info("connected to the panel", "url", c.opts.PanelURL)

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
						c.log.Warn("ping failed", "err", err)
						_ = ws.CloseNow() // dead peer: no point waiting for the close handshake
					}
					return
				}
			}
		}
	}()

	// send stays bound to THIS session: after reconnecting, a late reply
	// cannot go out over the new session
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
			c.log.Warn("invalid message", "err", err)
			continue
		}
		go c.dispatch(sctx, env, send)
	}
}

func (c *Client) dispatch(ctx context.Context, env *mcsmv1.Envelope, send func(*mcsmv1.Envelope) error) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("panic in the handler", "panic", r, "stack", string(debug.Stack()))
		}
	}()
	c.opts.Handler.Handle(ctx, env, send)
}
