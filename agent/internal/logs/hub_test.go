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

const hangGuard = 10 * time.Second // only prevents hanging the suite: generous for loaded machines

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
			t.Fatal("channel closed")
		}
		return l
	case <-time.After(hangGuard):
		t.Fatal("timeout waiting for line")
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
	f.WriteLog(id, "2026-10-12T10:00:00Z one\n2026-10-12T10:00:01Z two\n")
	recv(t, ch1)
	recv(t, ch1)
	ch2, unsub2, _ := h.Subscribe("a", id, 100)
	defer unsub2()
	if got := recv(t, ch2).Text; got != "one" {
		t.Fatalf("replay[0] = %q", got)
	}
	if got := recv(t, ch2).Text; got != "two" {
		t.Fatalf("replay[1] = %q", got)
	}
	if calls := eng.logsCalls.Load(); calls != 1 {
		t.Fatalf("must share a single follower; Logs called %d times", calls)
	}
}

func TestGraceClosesFollower(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetGrace(20 * time.Millisecond)
	fired := make(chan struct{})
	h.graceDone = func() { close(fired) }
	_, unsub, _ := h.Subscribe("a", id, 10)
	unsub()
	select {
	case <-fired:
	case <-time.After(hangGuard):
		t.Fatal("the grace timer did not fire")
	}
	h.mu.Lock()
	_, alive := h.followers["a"]
	h.mu.Unlock()
	if alive {
		t.Fatal("the follower must close after the grace period")
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
			t.Fatal("expected closed channel")
		}
	case <-time.After(hangGuard):
		t.Fatal("the channel should close after Reset")
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
	f.WriteLog(id2, "2026-10-12T10:00:00Z new\n")
	if got := recv(t, ch2).Text; got != "new" {
		t.Fatalf("got %q", got)
	}
}

// countEngine counts the calls to Logs without reading f.Calls (which has no accessible lock).
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
	h.graceHook = func() { // the timer already fired: a Subscribe enters the window
		s, err := h.SubscribeSub("a", id, 10)
		if err != nil {
			t.Error(err)
		}
		subCh <- s
	}
	dropped := make(chan struct{})
	h.graceDone = func() { close(dropped) }
	unsub()
	var sub *Subscription
	select {
	case sub = <-subCh:
	case <-time.After(hangGuard):
		t.Fatal("the hook did not run")
	}
	select { // dropIfIdle already decided (with the new subscription, it closes nothing)
	case <-dropped:
	case <-time.After(hangGuard):
		t.Fatal("dropIfIdle did not finish")
	}
	f.WriteLog(id, "2026-10-12T10:00:00Z vivo\n")
	if got := recv(t, sub.Lines).Text; got != "vivo" {
		t.Fatalf("the subscription must stay alive and receive; got %q", got)
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
				t.Fatalf("iteration %d: channel closed right after subscribing", i)
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
		t.Fatalf("long line not truncated: len=%d", len(l.Text))
	}
	if got := recv(t, ch).Text; got != "normal" {
		t.Fatalf("got %q", got)
	}
}

// A log line takes at most 64 KiB (plus the marker): with the 500-line ring
// a container cannot make the agent retain hundreds of MiB (M1 of the audit).
func TestLineCappedAt64KiB(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	ch, unsub, _ := h.Subscribe("a", id, 10)
	defer unsub()
	go f.WriteLog(id, "2026-10-12T10:00:00Z "+strings.Repeat("y", 100*1024)+"\n")
	l := recv(t, ch)
	if !strings.HasSuffix(l.Text, truncMarker) || len(l.Text) > 64*1024+len(truncMarker) {
		t.Fatalf("a 100 KiB line must be truncated to 64 KiB: len=%d", len(l.Text))
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
	read := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < n; i++ {
			f.WriteLog(id, "2026-10-12T10:00:00Z l\n")
			// Hand-off with the reader: without it, if the scheduler does not let the test run (GOMAXPROCS=1, loaded
			// CI), the fast one's buffer also fills up and drops. If publish blocked on the
			// slow one, recv would time out anyway.
			select {
			case <-read:
			case <-time.After(hangGuard):
				return
			}
		}
	}()
	for i := 0; i < n; i++ { // the fast one receives everything even if the slow one does not read
		recv(t, fast)
		select {
		case read <- struct{}{}:
		case <-done:
		}
	}
	<-done
	// publish distributes to subscribers in map order with f.mu held: the
	// fast one may receive the last line before the slow one's drop
	// is counted. Close takes f.mu, so it waits for that publish and fixes the count.
	slow.Close()
	if got := slow.Dropped(); got != 50 {
		t.Fatalf("Dropped = %d, wanted 50", got)
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
			t.Fatal("expected close")
		}
	case <-time.After(hangGuard):
		t.Fatal("EOF must close the channel")
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
		return []string{"abcdefgh", "short", "", "CF$2a$10$key"}
	})
	ch, unsub, err := h.Subscribe("a", id, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	f.WriteLog(id, "2026-10-12T10:00:00Z rcon=abcdefgh key=CF$2a$10$key short abcdefgh\n")
	want := "rcon=[hidden] key=[hidden] short [hidden]"
	if got := recv(t, ch).Text; got != want {
		t.Fatalf("got %q", got)
	}
	ch2, unsub2, _ := h.Subscribe("a", id, 10) // the replay comes from the ring, already clean
	defer unsub2()
	if got := recv(t, ch2).Text; got != want {
		t.Fatalf("replay %q", got)
	}
}

// A secret that contains another is hidden whole (longest first), and one cut off when truncating a long line does not
// leave its beginning visible.
func TestSecretsOverlappingAndTruncated(t *testing.T) {
	f, id := newFakeWithContainer(t)
	h := NewHub(f)
	h.SetSecrets(func(string) []string { return []string{"abcdefgh", "abcdefghXYZ12345"} })
	ch, unsub, err := h.Subscribe("a", id, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	f.WriteLog(id, "2026-10-12T10:00:00Z pw=abcdefghXYZ12345 and abcdefgh\n")
	if got := recv(t, ch).Text; got != "pw=[hidden] and [hidden]" {
		t.Fatalf("overlapping: %q", got)
	}
	// The line is truncated at maxLineBytes right in the middle of the long secret.
	ts := "2026-10-12T10:00:01Z "
	pad := strings.Repeat("x", maxLineBytes-len(ts)-5)
	f.WriteLog(id, ts+pad+"abcdefghXYZ12345 rest\n")
	got := recv(t, ch).Text
	if !strings.HasSuffix(got, redacted+truncMarker) || strings.Contains(got, "abcde") {
		t.Fatalf("truncated: …%q", got[len(got)-40:])
	}
}
