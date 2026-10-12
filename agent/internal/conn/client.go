package conn

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
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
	Log          *slog.Logger
}

type Client struct {
	opts       Options
	log        *slog.Logger
	backoffMin time.Duration
	backoffMax time.Duration
	pingEvery  time.Duration

	mu        sync.Mutex // protege solo el puntero ws; coder/websocket serializa las escrituras
	ws        *websocket.Conn
	connected atomic.Bool
}

func NewClient(o Options) *Client {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Client{opts: o, log: o.Log.With("component", "conn"),
		backoffMin: time.Second, backoffMax: 30 * time.Second, pingEvery: pingEvery}
}

func (c *Client) Connected() bool { return c.connected.Load() }

// Send escribe un mensaje binario. Es seguro para uso concurrente
// (coder/websocket permite múltiples escritores).
func (c *Client) Send(ctx context.Context, env *mcsmv1.Envelope) error {
	c.mu.Lock()
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		return ErrNotConnected
	}
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
		established, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if established {
			wait = c.backoffMin
		}
		d := jittered(wait)
		c.log.Warn("sesión terminada", "err", err, "reintento_en", d)
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
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

// session devuelve established=true si llegó a enviar el Hello.
func (c *Client) session(ctx context.Context) (established bool, err error) {
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	ws, _, err := websocket.Dial(dctx, wsURL(c.opts.PanelURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.opts.Token}},
	})
	cancel()
	if err != nil {
		return false, err
	}
	ws.SetReadLimit(readLimit)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	c.mu.Lock()
	c.ws = ws
	c.mu.Unlock()
	c.connected.Store(true)
	defer func() {
		stop()
		c.connected.Store(false)
		c.mu.Lock()
		c.ws = nil
		c.mu.Unlock()
		_ = ws.Close(websocket.StatusNormalClosure, "bye")
		if c.opts.OnDisconnect != nil {
			c.opts.OnDisconnect()
		}
	}()

	if err := c.Send(sctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_Hello{Hello: c.opts.Hello(sctx)}}); err != nil {
		return false, err
	}
	established = true
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
				err := ws.Ping(pctx)
				pc()
				if err != nil {
					if sctx.Err() == nil {
						c.log.Warn("ping fallido", "err", err)
						_ = ws.Close(websocket.StatusGoingAway, "ping timeout")
					}
					return
				}
			}
		}
	}()

	send := func(e *mcsmv1.Envelope) error { return c.Send(sctx, e) }
	for {
		_, data, err := ws.Read(sctx)
		if err != nil {
			return established, err
		}
		env := &mcsmv1.Envelope{}
		if err := proto.Unmarshal(data, env); err != nil {
			c.log.Warn("mensaje inválido", "err", err)
			continue
		}
		go c.opts.Handler.Handle(sctx, env, send)
	}
}
