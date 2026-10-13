// Package crashloop detects server crash loops (spec §10): a server that exits with an error
// more than MaxCrashes times within Window is stopped. Intents tells stops that someone asked for (the agent
// when stopping, recreating or deleting; mc-router through the socket proxy) apart from crashes: each one explains a die.
package crashloop

import (
	"context"
	"strconv"
	"sync"
	"time"

	"mcsm/agent/internal/docker"
)

const (
	// Window is the window in which crashes are counted.
	Window = time.Hour
	// MaxCrashes: with more than this many crashes within Window the server is in a loop.
	MaxCrashes = 3
	// IntentTTL: the first die up to this long after a requested Stop/Kill/Remove is not a crash. It covers the
	// wait for a clean stop (reconcile.StopTimeout, 60 s) with margin.
	IntentTTL = 3 * time.Minute
)

// Tracker counts each server's crashes in the last Window. Safe for concurrent use.
type Tracker struct {
	mu   sync.Mutex
	now  func() time.Time
	hits map[string][]time.Time
}

// NewTracker creates a counter with the given clock (time.Now if nil).
func NewTracker(now func() time.Time) *Tracker {
	if now == nil {
		now = time.Now
	}
	return &Tracker{now: now, hits: map[string][]time.Time{}}
}

// Record notes a crash of serverID and returns how many it has in the last Window and whether it exceeds MaxCrashes. When
// it trips it forgets the previous ones: after the stop, the server's count starts from zero.
func (t *Tracker) Record(serverID string) (count int, tripped bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	var keep []time.Time
	for _, h := range t.hits[serverID] {
		if now.Sub(h) < Window {
			keep = append(keep, h)
		}
	}
	keep = append(keep, now)
	if len(keep) > MaxCrashes {
		delete(t.hits, serverID)
		return len(keep), true
	}
	t.hits[serverID] = keep
	return len(keep), false
}

// Reset forgets serverID's crashes (e.g. when it is started by hand).
func (t *Tracker) Reset(serverID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.hits, serverID)
}

// Intents remembers, per container, the requested stops (Stop, Kill, Remove) of the last IntentTTL. Each one
// explains a single die: a loop that starts right after a Restart is counted from the first crash.
// Safe for concurrent use.
type Intents struct {
	mu  sync.Mutex
	now func() time.Time
	at  map[string][]time.Time // per container, oldest to newest
}

// NewIntents creates the registry with the given clock (time.Now if nil).
func NewIntents(now func() time.Time) *Intents {
	if now == nil {
		now = time.Now
	}
	return &Intents{now: now, at: map[string][]time.Time{}}
}

// Note records that someone asked to stop (or kill, or delete) container id. It prunes expired notes from
// all containers (a stop without a die, e.g. on one already stopped or deleted, does not linger forever).
func (i *Intents) Note(id string) {
	if id == "" {
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	now := i.now()
	for k := range i.at {
		i.pruneLocked(k, now)
	}
	i.at[id] = append(i.at[id], now)
}

// Consume reports whether a die of id is explained by a stop requested at most IntentTTL ago and, if so, spends it.
func (i *Intents) Consume(id string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	pending := i.pruneLocked(id, i.now())
	if len(pending) == 0 {
		return false
	}
	if len(pending) == 1 {
		delete(i.at, id)
	} else {
		i.at[id] = pending[1:]
	}
	return true
}

// pruneLocked removes the expired notes of id and returns the ones that remain.
func (i *Intents) pruneLocked(id string, now time.Time) []time.Time {
	list := i.at[id]
	n := 0
	for n < len(list) && now.Sub(list[n]) > IntentTTL {
		n++
	}
	if n == len(list) {
		delete(i.at, id)
		return nil
	}
	if n > 0 {
		list = list[n:]
		i.at[id] = list
	}
	return list
}

// Engine wraps a docker.Engine and records in Intents every stop, kill or delete the agent requests. Everything
// else goes to the engine underneath.
type Engine struct {
	docker.Engine
	Intents *Intents
}

func (e Engine) Stop(ctx context.Context, id string, timeout time.Duration) error {
	e.Intents.Note(id)
	return e.Engine.Stop(ctx, id, timeout)
}

func (e Engine) Kill(ctx context.Context, id string) error {
	e.Intents.Note(id)
	return e.Engine.Kill(ctx, id)
}

func (e Engine) Remove(ctx context.Context, id string) error {
	e.Intents.Note(id)
	return e.Engine.Remove(ctx, id)
}

// ExitCode returns the exit code of a die event (Docker's exitCode attribute, which Moby.Events copies
// into Event.Labels). false if it is missing or not a number.
func ExitCode(ev docker.Event) (int, bool) {
	v, ok := ev.Labels["exitCode"]
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	return n, err == nil
}
