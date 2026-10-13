package logs

import (
	"context"
	"io"
	"strings"
	"sync/atomic"
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
	eng := &countEngine{Engine: f}
	h := NewHub(eng)
	ch1, unsub1, _ := h.Subscribe("a", id, 100)
	defer unsub1()
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
	if calls := eng.logsCalls.Load(); calls != 1 {
		t.Fatalf("debe compartir un único follower; Logs llamado %d veces", calls)
	}
}

func TestGraceClosesFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(20 * time.Millisecond)
	_, unsub, _ := h.Subscribe("a", id, 10)
	unsub()
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		_, alive := h.followers["a"]
		h.mu.Unlock()
		if !alive {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("el follower debe cerrarse pasado el periodo de gracia")
		}
		time.Sleep(time.Millisecond)
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
	f.WriteLog(id2, "2026-10-12T10:00:00Z nuevo\n")
	if got := recv(t, ch2).Text; got != "nuevo" {
		t.Fatalf("got %q", got)
	}
}

// countEngine cuenta las llamadas a Logs sin leer f.Calls (que no tiene lock accesible).
type countEngine struct {
	docker.Engine
	logsCalls atomic.Int32
}

func (e *countEngine) Logs(ctx context.Context, id string, tail int) (io.ReadCloser, error) {
	e.logsCalls.Add(1)
	return e.Engine.Logs(ctx, id, tail)
}

func TestGraceRaceSubscribeBeforeDrop(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(time.Nanosecond)
	_, unsub, _ := h.Subscribe("a", id, 10)
	subCh := make(chan *Subscription, 1)
	h.graceHook = func() { // el temporizador ya disparó: un Subscribe entra en la ventana
		s, err := h.SubscribeSub("a", id, 10)
		if err != nil {
			t.Error(err)
		}
		subCh <- s
	}
	unsub()
	var sub *Subscription
	select {
	case sub = <-subCh:
	case <-time.After(2 * time.Second):
		t.Fatal("el hook no se ejecutó")
	}
	time.Sleep(20 * time.Millisecond) // deja correr dropIfIdle
	f.WriteLog(id, "2026-10-12T10:00:00Z vivo\n")
	if got := recv(t, sub.Lines).Text; got != "vivo" {
		t.Fatalf("la suscripción debe seguir viva y recibir; got %q", got)
	}
}

func TestSubscribeNeverReturnsClosedFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(time.Nanosecond)
	for i := 0; i < 200; i++ {
		s, err := h.SubscribeSub("a", id, 10)
		if err != nil {
			t.Fatal(err)
		}
		select {
		case _, ok := <-s.Lines:
			if !ok {
				t.Fatalf("iteración %d: canal cerrado nada más suscribirse", i)
			}
		default:
		}
		s.Close()
	}
}

func TestLongLineTruncatedAndFollowerSurvives(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	defer unsub()
	go f.WriteLog(id, "2026-10-12T10:00:00Z "+strings.Repeat("x", 2*1024*1024)+"\n2026-10-12T10:00:01Z normal\n")
	l := recv(t, ch)
	if !strings.HasSuffix(l.Text, truncMarker) || len(l.Text) > maxLineBytes+len(truncMarker) {
		t.Fatalf("línea larga no truncada: len=%d", len(l.Text))
	}
	if got := recv(t, ch).Text; got != "normal" {
		t.Fatalf("got %q", got)
	}
}

// Una línea de log ocupa como mucho 64 KiB (más el marcador): con el ring de 500 líneas
// un contenedor no puede hacer que el agente retenga cientos de MiB (M1 de la auditoría).
func TestLineCappedAt64KiB(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	defer unsub()
	go f.WriteLog(id, "2026-10-12T10:00:00Z "+strings.Repeat("y", 100*1024)+"\n")
	l := recv(t, ch)
	if !strings.HasSuffix(l.Text, truncMarker) || len(l.Text) > 64*1024+len(truncMarker) {
		t.Fatalf("una línea de 100 KiB debe truncarse a 64 KiB: len=%d", len(l.Text))
	}
}

func TestReplayRespectsTail(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch1, unsub1, _ := h.Subscribe("a", id, 100)
	defer unsub1()
	f.WriteLog(id, "2026-10-12T10:00:00Z a\n2026-10-12T10:00:01Z b\n2026-10-12T10:00:02Z c\n")
	for i := 0; i < 3; i++ {
		recv(t, ch1)
	}
	ch2, unsub2, _ := h.Subscribe("a", id, 2)
	defer unsub2()
	if got := recv(t, ch2).Text; got != "b" {
		t.Fatalf("got %q", got)
	}
	if got := recv(t, ch2).Text; got != "c" {
		t.Fatalf("got %q", got)
	}
}

func TestSlowSubscriberCountsDropsAndDoesNotBlock(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	slow, err := h.SubscribeSub("a", id, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	fast, unsubFast, _ := h.Subscribe("a", id, 10)
	defer unsubFast()
	const n = subBuffer + 50
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < n; i++ {
			f.WriteLog(id, "2026-10-12T10:00:00Z l\n")
		}
	}()
	for i := 0; i < n; i++ { // el rápido recibe todo aunque el lento no lea
		recv(t, fast)
	}
	<-done
	// publish reparte a los suscriptores en orden de mapa con f.mu tomado: el
	// rápido puede recibir la última línea antes de que se cuente el descarte
	// del lento. Close toma f.mu, así que espera a ese publish y fija la cuenta.
	slow.Close()
	if got := slow.Dropped(); got != 50 {
		t.Fatalf("Dropped = %d, quería 50", got)
	}
}

func TestEOFClosesChannelsAndDoubleUnsub(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	if err := f.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("esperaba cierre")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("EOF debe cerrar el canal")
	}
	unsub()
	unsub()
}

func TestSecretsAreRedactedBeforeTheRing(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetSecrets(func(serverID string) []string {
		if serverID != "a" {
			return nil
		}
		return []string{"abcdefgh", "corto", "", "CF$2a$10$clave"}
	})
	ch, unsub, err := h.Subscribe("a", id, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	f.WriteLog(id, "2026-10-12T10:00:00Z rcon=abcdefgh key=CF$2a$10$clave corto abcdefgh\n")
	want := "rcon=[oculto] key=[oculto] corto [oculto]"
	if got := recv(t, ch).Text; got != want {
		t.Fatalf("got %q", got)
	}
	ch2, unsub2, _ := h.Subscribe("a", id, 10) // el replay sale del anillo, ya limpio
	defer unsub2()
	if got := recv(t, ch2).Text; got != want {
		t.Fatalf("replay %q", got)
	}
}
