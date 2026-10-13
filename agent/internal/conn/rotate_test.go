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
		for { // Hello and whatever arrives, until the client closes
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	c := NewClient(Options{PanelURL: srv.URL, Token: "OLD", Handler: &captureHandler{}, Log: quiet,
		Hello: func(context.Context) *mcsmv1.Hello { return &mcsmv1.Hello{} }})
	c.after = func(time.Duration) <-chan time.Time { // no waits between sessions
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)
	waitConnected(t, c)
	c.SetToken("NEW")
	c.Reconnect()
	waitFor(t, "second session", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(tokens) >= 2
	})
	mu.Lock()
	defer mu.Unlock()
	if tokens[0] != "OLD" || tokens[1] != "NEW" {
		t.Fatalf("tokens = %v", tokens)
	}
}
