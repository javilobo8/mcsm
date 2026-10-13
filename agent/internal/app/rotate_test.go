package app

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/store"
)

func rotate(a *App, tok string, send func(*mcsmv1.Envelope) error) {
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_RotateToken{RotateToken: &mcsmv1.RotateToken{Token: tok}}}, send)
}

func TestRotateTokenSavesBeforeAckAndReconnectsAfter(t *testing.T) {
	a, _, st := newApp(t)
	if err := st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "old"}); err != nil {
		t.Fatal(err)
	}
	tok := strings.Repeat("A", 42) + "_"
	var order []string
	a.setToken = func(v string) { order = append(order, "token="+v) }
	a.reconnect = func() { order = append(order, "reconnect") }
	rotate(a, tok, func(e *mcsmv1.Envelope) error {
		creds, _ := st.Credentials()
		order = append(order, fmt.Sprintf("ack=%v saved=%v", e.GetAck() != nil && e.Id == 5, creds.Token == tok))
		return nil
	})
	want := []string{"token=" + tok, "ack=true saved=true", "reconnect"}
	if !slices.Equal(order, want) {
		t.Fatalf("order = %v", order)
	}
	if creds, _ := st.Credentials(); creds.NodeID != "n1" {
		t.Fatalf("the node does not change: %+v", creds)
	}
}

func TestRotateTokenRejectsBadTokensAndMissingCredentials(t *testing.T) {
	a, _, st := newApp(t)
	called := false
	a.setToken = func(string) { called = true }
	a.reconnect = func() { called = true }
	s := newSink()
	rotate(a, "short", s.send)
	if e := s.waitID(t, 5); e.GetError().GetCode() != "invalid_request" {
		t.Fatalf("resp = %+v", e)
	}
	rotate(a, strings.Repeat("B", 43), s.send) // without stored credentials
	if e := s.waitID(t, 5); e.GetError().GetCode() != "io_error" {
		t.Fatalf("resp = %+v", e)
	}
	if called {
		t.Fatal("without saving, neither the token changes nor does it reconnect")
	}
	if creds, _ := st.Credentials(); creds != nil {
		t.Fatalf("credentials = %+v", creds)
	}
}

// Two RotateTokens at once (the client dispatches each message in its goroutine) are served one at a time: otherwise the
// store could end up with one token and the client with the other. The handler holds rotateMu from when it saves
// until it reconnects: at each step, nobody else can take it (TryLock fails), without deadlines.
func TestRotateTokenIsSerialized(t *testing.T) {
	a, _, st := newApp(t)
	if err := st.SaveCredentials(store.Credentials{NodeID: "n1", Token: "old"}); err != nil {
		t.Fatal(err)
	}
	held := func(step string) {
		if a.rotateMu.TryLock() {
			a.rotateMu.Unlock()
			t.Errorf("%s: another rotation could sneak in here", step)
		}
	}
	var steps []string
	a.setToken = func(string) { held("setToken"); steps = append(steps, "setToken") }
	a.reconnect = func() { held("reconnect"); steps = append(steps, "reconnect") }
	rotate(a, strings.Repeat("A", 43), func(e *mcsmv1.Envelope) error {
		held("ack")
		steps = append(steps, "ack")
		return nil
	})
	if !slices.Equal(steps, []string{"setToken", "ack", "reconnect"}) {
		t.Fatalf("steps = %v", steps)
	}
	if !a.rotateMu.TryLock() {
		t.Fatal("when finished, the lock is left free")
	}
	a.rotateMu.Unlock()
}
