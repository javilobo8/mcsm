package app

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/store"
)

func rotate(a *App, tok string, send func(*mcsmv1.Envelope) error) {
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_RotateToken{RotateToken: &mcsmv1.RotateToken{Token: tok}}}, send)
}

func TestRotateTokenSavesBeforeAckAndReconnectsAfter(t *testing.T) {
	a, _, st := newApp(t)
	if err := st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "viejo"}); err != nil {
		t.Fatal(err)
	}
	tok := strings.Repeat("A", 42) + "_"
	var order []string
	a.setToken = func(v string) { order = append(order, "token="+v) }
	a.reconnect = func() { order = append(order, "reconnect") }
	rotate(a, tok, func(e *mcsmv1.Envelope) error {
		creds, _ := st.Credentials()
		order = append(order, fmt.Sprintf("ack=%v guardado=%v", e.GetAck() != nil && e.Id == 5, creds.Token == tok))
		return nil
	})
	want := []string{"token=" + tok, "ack=true guardado=true", "reconnect"}
	if !slices.Equal(order, want) {
		t.Fatalf("orden = %v", order)
	}
	if creds, _ := st.Credentials(); creds.NodeID != "n1" {
		t.Fatalf("el nodo no cambia: %+v", creds)
	}
}

func TestRotateTokenRejectsBadTokensAndMissingCredentials(t *testing.T) {
	a, _, st := newApp(t)
	called := false
	a.setToken = func(string) { called = true }
	a.reconnect = func() { called = true }
	s := newSink()
	rotate(a, "corto", s.send)
	if e := s.waitID(t, 5); e.GetError().GetCode() != "invalid_request" {
		t.Fatalf("resp = %+v", e)
	}
	rotate(a, strings.Repeat("B", 43), s.send) // sin credenciales guardadas
	if e := s.waitID(t, 5); e.GetError().GetCode() != "io_error" {
		t.Fatalf("resp = %+v", e)
	}
	if called {
		t.Fatal("sin guardar no se cambia de token ni se reconecta")
	}
	if creds, _ := st.Credentials(); creds != nil {
		t.Fatalf("credenciales = %+v", creds)
	}
}

// Dos RotateToken a la vez (el cliente despacha cada mensaje en su goroutine) se atienden de uno en uno: si no, el
// store podría quedarse con un token y el cliente con el otro.
func TestRotateTokenIsSerialized(t *testing.T) {
	a, _, st := newApp(t)
	if err := st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "viejo"}); err != nil {
		t.Fatal(err)
	}
	tokA, tokB := strings.Repeat("A", 43), strings.Repeat("B", 43)
	firstIn := make(chan struct{})
	secondAcked := make(chan struct{})
	var mu sync.Mutex
	var client string
	a.setToken = func(v string) {
		if v == tokA {
			close(firstIn)
			// Sin serializar, la segunda rotación termina entera mientras la primera está aquí. Con ella no
			// puede: el plazo solo da tiempo a que se cuele si el código lo permite (nunca falla en falso).
			select {
			case <-secondAcked:
				t.Error("la segunda rotación terminó en medio de la primera")
			case <-time.After(100 * time.Millisecond):
			}
		}
		mu.Lock()
		client = v
		mu.Unlock()
	}
	done := make(chan struct{})
	go func() {
		rotate(a, tokA, func(*mcsmv1.Envelope) error { return nil })
		close(done)
	}()
	<-firstIn
	rotate(a, tokB, func(e *mcsmv1.Envelope) error {
		if e.GetAck() != nil {
			close(secondAcked)
		}
		return nil
	})
	<-done
	creds, _ := st.Credentials()
	mu.Lock()
	defer mu.Unlock()
	if creds.Token != client {
		t.Fatalf("store=%s… cliente=%s…: desincronizados", creds.Token[:1], client[:1])
	}
}
