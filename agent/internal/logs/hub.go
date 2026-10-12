// Package logs sigue los logs de los contenedores y los reparte a suscriptores.
package logs

import (
	"bufio"
	"context"
	"strings"
	"sync"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	ringSize     = 500
	subBuffer    = 1024
	defaultGrace = 30 * time.Second
)

type Line struct {
	TS   time.Time
	Text string
}

type Hub struct {
	eng       docker.Engine
	mu        sync.Mutex
	followers map[string]*follower
	grace     time.Duration
}

type follower struct {
	hub         *Hub
	serverID    string
	containerID string
	cancel      context.CancelFunc
	mu          sync.Mutex
	ring        []Line
	subs        map[int]chan Line
	nextSub     int
	closed      bool
	graceTimer  *time.Timer
}

func NewHub(eng docker.Engine) *Hub {
	return &Hub{eng: eng, followers: map[string]*follower{}, grace: defaultGrace}
}

func (h *Hub) SetGrace(d time.Duration) { h.grace = d }

func (h *Hub) Subscribe(serverID, containerID string, tail int) (<-chan Line, func(), error) {
	h.mu.Lock()
	f, ok := h.followers[serverID]
	if ok && f.containerID != containerID {
		f.close()
		delete(h.followers, serverID)
		ok = false
	}
	if !ok {
		ctx, cancel := context.WithCancel(context.Background())
		rc, err := h.eng.Logs(ctx, containerID, tail)
		if err != nil {
			cancel()
			h.mu.Unlock()
			return nil, nil, err
		}
		f = &follower{hub: h, serverID: serverID, containerID: containerID, cancel: cancel, subs: map[int]chan Line{}}
		h.followers[serverID] = f
		go f.run(ctx, rc)
	}
	h.mu.Unlock()
	return f.subscribe()
}

func (h *Hub) Reset(serverID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.followers[serverID]; ok {
		f.close()
		delete(h.followers, serverID)
	}
}

// drop cierra f y lo quita del mapa solo si sigue siendo el follower vigente.
func (h *Hub) drop(f *follower) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.followers[f.serverID] == f {
		delete(h.followers, f.serverID)
	}
	f.close()
}

func (f *follower) subscribe() (<-chan Line, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.graceTimer != nil {
		f.graceTimer.Stop()
		f.graceTimer = nil
	}
	ch := make(chan Line, subBuffer)
	for _, l := range f.ring {
		ch <- l
	}
	if f.closed {
		close(ch)
		return ch, func() {}, nil
	}
	id := f.nextSub
	f.nextSub++
	f.subs[id] = ch
	var once sync.Once
	unsub := func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			delete(f.subs, id)
			if len(f.subs) == 0 && !f.closed {
				f.graceTimer = time.AfterFunc(f.hub.grace, func() {
					f.mu.Lock()
					idle := len(f.subs) == 0
					f.mu.Unlock()
					if idle {
						f.hub.drop(f)
					}
				})
			}
		})
	}
	return ch, unsub, nil
}

func (f *follower) run(ctx context.Context, rc interface {
	Read([]byte) (int, error)
	Close() error
}) {
	defer rc.Close()
	go func() { <-ctx.Done(); rc.Close() }()
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		f.publish(parseLine(sc.Text()))
	}
	f.hub.drop(f)
}

func (f *follower) publish(l Line) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ring) == ringSize {
		copy(f.ring, f.ring[1:])
		f.ring = f.ring[:ringSize-1]
	}
	f.ring = append(f.ring, l)
	for _, ch := range f.subs {
		select {
		case ch <- l:
		default: // suscriptor lento: se descarta la línea para no bloquear al resto
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
	f.cancel()
	for id, ch := range f.subs {
		close(ch)
		delete(f.subs, id)
	}
}

// parseLine separa el timestamp RFC3339Nano que añade Docker ("2026-...Z texto").
// Las líneas de TTY pueden traer \r al final; se elimina.
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
