// Package logs follows the containers' logs and distributes them to subscribers.
package logs

import (
	"bufio"
	"context"
	"io"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	ringSize     = 500
	subBuffer    = 1024
	maxLineBytes = 64 * 1024 // the ring (500 lines) is bounded to ~32 MiB per server
	truncMarker  = " …[truncated]"
	defaultGrace = 30 * time.Second
	redacted     = "[hidden]"
	minSecretLen = 8 // shorter ones would hide normal text
)

type Line struct {
	TS   time.Time
	Text string
}

// Subscription is a subscription to a server's logs.
//
// Lines first delivers the replay of the circular buffer (the last `tail` lines,
// max. 500) and then the new ones. It closes when the follower dies (stream
// EOF, Reset, container deleted or container change). If the subscriber does not
// read and its buffer fills up, new lines are dropped without blocking anyone
// and counted: Dropped() returns the accumulated total, so that the WS layer emits
// StreamDropped{count} (spec §5.2) with the difference since the last notice.
// Close is idempotent and safe after the follower closes.
type Subscription struct {
	Lines   <-chan Line
	dropped atomic.Uint64
	unsub   func()
}

// Dropped returns the accumulated number of lines dropped for this subscriber.
func (s *Subscription) Dropped() uint64 { return s.dropped.Load() }

// Close unsubscribes (it starts the grace period if it was the last one).
func (s *Subscription) Close() { s.unsub() }

type Hub struct {
	eng       docker.Engine
	mu        sync.Mutex
	followers map[string]*follower
	grace     time.Duration
	secrets   func(serverID string) []string // plan-9: what must not appear in the console

	// graceHook (tests only) is invoked at the start of the grace timer's callback.
	graceHook func()
	// graceDone (tests only) is invoked at the end of the grace timer's callback, after dropIfIdle.
	graceDone func()
}

type subscriber struct {
	ch  chan Line
	sub *Subscription
}

type follower struct {
	hub         *Hub
	serverID    string
	containerID string
	secrets     []string
	cancel      context.CancelFunc
	mu          sync.Mutex
	ring        []Line
	subs        map[int]*subscriber
	nextSub     int
	closed      bool
	graceTimer  *time.Timer
}

func NewHub(eng docker.Engine) *Hub {
	return &Hub{eng: eng, followers: map[string]*follower{}, grace: defaultGrace}
}

// SetGrace changes the grace period (30 s by default) for upcoming unsubscribes.
func (h *Hub) SetGrace(d time.Duration) {
	h.mu.Lock()
	h.grace = d
	h.mu.Unlock()
}

// SetSecrets sets where, per server, what must be hidden in its logs comes from (RCON password, CurseForge API
// key; L2 of Plan 3: itzg's debug modes may print them). It is queried when each follower opens: a spec
// change recreates the container and opens another.
func (h *Hub) SetSecrets(fn func(serverID string) []string) {
	h.mu.Lock()
	h.secrets = fn
	h.mu.Unlock()
}

func (h *Hub) secretsOf(serverID string) []string {
	h.mu.Lock()
	fn := h.secrets
	h.mu.Unlock()
	if fn == nil {
		return nil
	}
	var out []string
	for _, s := range fn(serverID) {
		if len(s) >= minSecretLen {
			out = append(out, s)
		}
	}
	// Longest first: if one contains another, hiding the short one first would leave the rest of the long one visible.
	slices.SortStableFunc(out, func(a, b string) int { return len(b) - len(a) })
	return out
}

// redact replaces each occurrence of a secret with [hidden] (secrets, longest to shortest). In a truncated
// line (ending in truncMarker), the beginning of a secret cut off by the truncation is also hidden.
func redact(text string, secrets []string) string {
	for _, s := range secrets {
		if strings.Contains(text, s) {
			text = strings.ReplaceAll(text, s, redacted)
		}
	}
	body, truncated := strings.CutSuffix(text, truncMarker)
	if !truncated {
		return text
	}
	cut := 0 // the longest secret prefix the line ends with
	for _, s := range secrets {
		for k := len(s) - 1; k > cut; k-- {
			if strings.HasSuffix(body, s[:k]) {
				cut = k
				break
			}
		}
	}
	if cut == 0 {
		return text
	}
	return body[:len(body)-cut] + redacted + truncMarker
}

// Subscribe is SubscribeSub without a drop counter.
func (h *Hub) Subscribe(serverID, containerID string, tail int) (<-chan Line, func(), error) {
	s, err := h.SubscribeSub(serverID, containerID, tail)
	if err != nil {
		return nil, nil, err
	}
	return s.Lines, s.Close, nil
}

// SubscribeSub subscribes to serverID's logs. The first subscriber opens
// `docker logs --follow` with `tail` lines; later ones share the follower.
// If containerID differs from the current follower's, that one is closed and another is opened.
// It never returns a subscription to an already closed follower: in that case it opens a new one.
func (h *Hub) SubscribeSub(serverID, containerID string, tail int) (*Subscription, error) {
	for {
		h.mu.Lock()
		f := h.followers[serverID]
		if f != nil && f.containerID != containerID {
			f.close()
			delete(h.followers, serverID)
			f = nil
		}
		if f == nil {
			h.mu.Unlock()
			secrets := h.secretsOf(serverID)
			// Docker is queried without h.mu: a slow daemon does not block other servers.
			ctx, cancel := context.WithCancel(context.Background())
			rc, err := h.eng.Logs(ctx, containerID, tail)
			if err != nil {
				cancel()
				return nil, err
			}
			h.mu.Lock()
			if cur := h.followers[serverID]; cur != nil {
				// Another Subscribe got ahead of us: we discard our stream and retry.
				h.mu.Unlock()
				cancel()
				_ = rc.Close()
				continue
			}
			f = &follower{hub: h, serverID: serverID, containerID: containerID, secrets: secrets, cancel: cancel, subs: map[int]*subscriber{}}
			h.followers[serverID] = f
			go f.run(ctx, rc)
		}
		h.mu.Unlock()
		if s := f.subscribe(tail); s != nil {
			return s, nil
		}
		// The follower closed in between (grace, EOF, Reset): retry.
	}
}

func (h *Hub) Reset(serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.followers[serverID]; ok {
		f.close()
		delete(h.followers, serverID)
	}
}

// drop closes f and removes it from the map only if it is still the current follower.
func (h *Hub) drop(f *follower) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.followers[f.serverID] == f {
		delete(h.followers, f.serverID)
	}
	f.close()
}

// dropIfIdle checks that f still has no subscribers and closes it, atomically
// with respect to Subscribe (h.mu and then f.mu, the same order as drop).
func (h *Hub) dropIfIdle(f *follower) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f.mu.Lock()
	idle := len(f.subs) == 0
	f.mu.Unlock()
	if !idle {
		return
	}
	if h.followers[f.serverID] == f {
		delete(h.followers, f.serverID)
	}
	f.close()
}

// subscribe returns nil if the follower is already closed.
func (f *follower) subscribe(tail int) *Subscription {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil
	}
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	ch := make(chan Line, subBuffer)
	replay := f.ring
	if tail <= 0 {
		replay = nil
	} else if len(replay) > tail {
		replay = replay[len(replay)-tail:]
	}
	for _, l := range replay {
		ch <- l
	}
	s := &Subscription{Lines: ch}
	id := f.nextSub
	f.nextSub++
	f.subs[id] = &subscriber{ch: ch, sub: s}
	var once sync.Once
	s.unsub = func() {
		once.Do(func() {
			// h.mu before f.mu (same order as drop), so the grace is read first.
			f.hub.mu.Lock()
			grace := f.hub.grace
			f.hub.mu.Unlock()
			f.mu.Lock()
			defer f.mu.Unlock()
			delete(f.subs, id)
			if len(f.subs) == 0 && !f.closed {
				f.graceTimer = time.AfterFunc(grace, func() {
					if hook := f.hub.graceHook; hook != nil {
						hook()
					}
					f.hub.dropIfIdle(f)
					if done := f.hub.graceDone; done != nil {
						done()
					}
				})
			}
		})
	}
	return s
}

func (f *follower) run(ctx context.Context, rc io.ReadCloser) {
	defer rc.Close()
	go func() { <-ctx.Done(); rc.Close() }() // Close is idempotent in Fake and Moby
	br := bufio.NewReaderSize(rc, 64*1024)
	for {
		line, err := readLine(br)
		if line != nil {
			l := parseLine(string(line))
			l.Text = redact(l.Text, f.secrets)
			f.publish(l)
		}
		if err != nil {
			break
		}
	}
	f.hub.drop(f)
}

// readLine reads a line; if it exceeds maxLineBytes it truncates it (with a marker) and discards
// the rest instead of aborting. It returns the last partial line together with the error.
func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	truncated := false
	for {
		chunk, isPrefix, err := br.ReadLine()
		if len(chunk) > 0 {
			if room := maxLineBytes - len(buf); room > 0 {
				if len(chunk) > room {
					chunk = chunk[:room]
					truncated = true
				}
				buf = append(buf, chunk...)
			} else {
				truncated = true
			}
		}
		if err != nil {
			if truncated {
				buf = append(buf, truncMarker...)
			}
			if len(buf) == 0 {
				return nil, err
			}
			return buf, err
		}
		if !isPrefix {
			if truncated {
				buf = append(buf, truncMarker...)
			}
			if buf == nil {
				buf = []byte{}
			}
			return buf, nil
		}
	}
}

func (f *follower) publish(l Line) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ring) == ringSize {
		copy(f.ring, f.ring[1:])
		f.ring = f.ring[:ringSize-1]
	}
	f.ring = append(f.ring, l)
	for _, s := range f.subs {
		select {
		case s.ch <- l:
		default: // slow subscriber: dropped and counted so as not to block the rest
			s.sub.dropped.Add(1)
		}
	}
}

func (f *follower) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.closed = true
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	f.cancel()
	for id, s := range f.subs {
		close(s.ch)
		delete(f.subs, id)
	}
}

// parseLine splits off the RFC3339Nano timestamp Docker adds ("2026-...Z text").
// TTY lines may carry a trailing \r; it is removed.
func parseLine(raw string) Line {
	raw = strings.TrimRight(raw, "\r")
	ts, rest, ok := strings.Cut(raw, " ")
	if ok {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			return Line{TS: t, Text: rest}
		}
	}
	return Line{TS: time.Now(), Text: raw}
}
