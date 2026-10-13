package conn

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
)

func TestSetTokenAndReconnectDialWithTheNewToken(t *testing.T) {
	var mu sync.Mutex
	var tokens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		tokens = append(tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		mu.Unlock()
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		for { // Hello y lo que llegue, hasta que el cliente cierre
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	c := NewClient(Options{PanelURL: srv.URL, Token: "VIEJO", Handler: &captureHandler{}, Log: quiet,
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.after = func(time.Duration) <-chan time.Time { // sin esperas entre sesiones
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitConnected(t, c)
	c.SetToken("NUEVO")
	c.Reconnect()
	waitFor(t, "segunda sesión", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(tokens) >= 2
	})
	mu.Lock()
	defer mu.Unlock()
	if tokens[0] != "VIEJO" || tokens[1] != "NUEVO" {
		t.Fatalf("tokens = %v", tokens)
	}
}
