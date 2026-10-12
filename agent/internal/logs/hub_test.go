package logs

import (
	"context"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	"mcsm/agent/internal/docker"
)

func newFakeWithContainer(t *testing.T) (*docker.Fake, string) {
	f := docker.NewFake()
	id, err := f.Create(context.Background(), "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return f, id
}

func recv(t *testing.T, ch <-chan Line) Line {
	t.Helper()
	select {
	case l, ok := <-ch:
		if !ok {
			t.Fatal("canal cerrado")
		}
		return l
	case <-time.After(2 * time.Second):
		t.Fatal("timeout esperando línea")
	}
	return Line{}
}

func TestSubscribeParsesTimestamps(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, err := h.Subscribe("a", id, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id, "2026-10-12T10:00:00.123456789Z [10:00:00] [Server thread/INFO]: Done (3.2s)!\n")
	l := recv(t, ch)
	if l.Text != "[10:00:00] [Server thread/INFO]: Done (3.2s)!" {
		t.Fatalf("text = %q", l.Text)
	}
	if l.TS.UTC().Format(time.RFC3339) != "2026-10-12T10:00:00Z" {
		t.Fatalf("ts = %v", l.TS)
	}
}

func TestReplayAndSharedFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch1, unsub1, _ := h.Subscribe("a", id, 100)
	defer unsub1()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id, "2026-10-12T10:00:00Z uno\n2026-10-12T10:00:01Z dos\n")
	recv(t, ch1)
	recv(t, ch1)
	ch2, unsub2, _ := h.Subscribe("a", id, 100)
	defer unsub2()
	if got := recv(t, ch2).Text; got != "uno" {
		t.Fatalf("replay[0] = %q", got)
	}
	if got := recv(t, ch2).Text; got != "dos" {
		t.Fatalf("replay[1] = %q", got)
	}
	calls := 0
	for _, c := range f.Calls {
		if len(c) >= 4 && c[:4] == "Logs" {
			calls++
		}
	}
	if calls != 1 {
		t.Fatalf("debe compartir un único follower; Logs llamado %d veces", calls)
	}
}

func TestGraceClosesFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(20 * time.Millisecond)
	_, unsub, _ := h.Subscribe("a", id, 10)
	unsub()
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	_, alive := h.followers["a"]
	h.mu.Unlock()
	if alive {
		t.Fatal("el follower debe cerrarse pasado el periodo de gracia")
	}
}

func TestResetClosesSubscribers(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	defer unsub()
	h.Reset("a")
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("esperaba canal cerrado")
		}
	case <-time.After(time.Second):
		t.Fatal("el canal debería cerrarse tras Reset")
	}
}

func TestContainerIDChangeReopens(t *testing.T) {
	f, id := newFakeWithContainer(t)
	id2, _ := f.Create(context.Background(), "mcsm-b", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	h := NewHub(f)
	_, unsub1, _ := h.Subscribe("a", id, 10)
	defer unsub1()
	ch2, unsub2, _ := h.Subscribe("a", id2, 10)
	defer unsub2()
	time.Sleep(20 * time.Millisecond)
	f.WriteLog(id2, "2026-10-12T10:00:00Z nuevo\n")
	if got := recv(t, ch2).Text; got != "nuevo" {
		t.Fatalf("got %q", got)
	}
}
