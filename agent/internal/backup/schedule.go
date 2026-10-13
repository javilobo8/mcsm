package backup

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"mcsm/agent/internal/spec"
)

// Clock is the scheduler's clock (injectable in tests).
type Clock interface {
	Now() time.Time
	// Until returns a channel that receives a value when the clock reaches t.
	Until(t time.Time) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                     { return time.Now() }
func (realClock) Until(t time.Time) <-chan time.Time { return time.After(time.Until(t)) }

// RealClock is the system clock. Cron expressions are interpreted in its time
// zone (TZ variable of the agent's container; UTC if not defined).
var RealClock Clock = realClock{}

// maxSchedWait bounds each wait: a jump of the system clock is corrected within ≤ 1 min.
const maxSchedWait = time.Minute

// maxLate is the maximum lateness with which a run still fires: if the agent (or the
// machine) was suspended longer, the run is skipped and the next one is recomputed.
const maxLate = 5 * time.Minute

type schedEntry struct {
	expr  string
	sched cron.Schedule
	next  time.Time
}

// Scheduler fires fire(serverID) according to each server's cron expression. It uses
// robfig/cron's cron.ParseStandard to compute the next run and a loop of its own
// with an injectable clock (robfig's runner uses the real clock and cannot be tested). A
// missed run (agent stopped) is not recovered.
type Scheduler struct {
	clock   Clock
	fire    func(serverID string)
	mu      sync.Mutex
	entries map[string]*schedEntry
	wake    chan struct{}
}

// NewScheduler creates the scheduler. fire is called from the loop: it must return right away.
func NewScheduler(clock Clock, fire func(serverID string)) *Scheduler {
	return &Scheduler{clock: clock, fire: fire, entries: map[string]*schedEntry{}, wake: make(chan struct{}, 1)}
}

// Set schedules a server or reschedules it if the expression changed (if it did not change, it keeps
// the next run). An empty expression unschedules it.
func (s *Scheduler) Set(serverID, expr string) error {
	if expr == "" {
		s.Remove(serverID)
		return nil
	}
	// ValidCron applies the same criterion as the panel (no @daily, names, ? or CRON_TZ,
	// ASCII only); ParseStandard alone would accept them. It validates the original expression, before
	// normalizing. See TestSchedulerSetMatchesPanelFixture.
	if err := spec.ValidCron(expr); err != nil {
		return err
	}
	expr = strings.Join(strings.Fields(expr), " ") // a variant with extra spaces does not reschedule
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entries[serverID]; ok && e.expr == expr {
		return nil
	}
	sched, err := cron.ParseStandard(expr)
	if err != nil {
		return err
	}
	s.entries[serverID] = &schedEntry{expr: expr, sched: sched, next: sched.Next(s.clock.Now())}
	s.poke()
	return nil
}

// Remove unschedules a server.
func (s *Scheduler) Remove(serverID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[serverID]; ok {
		delete(s.entries, serverID)
		s.poke()
	}
}

// IDs returns the scheduled servers, sorted.
func (s *Scheduler) IDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.entries))
	for id := range s.entries {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Next returns a server's next run.
func (s *Scheduler) Next(serverID string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[serverID]
	if !ok {
		return time.Time{}, false
	}
	return e.next, true
}

func (s *Scheduler) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run runs the loop until ctx ends.
func (s *Scheduler) Run(ctx context.Context) {
	for {
		now := s.clock.Now()
		wakeAt := now.Add(maxSchedWait)
		type dueItem struct {
			id    string
			entry *schedEntry
		}
		var due []dueItem
		s.mu.Lock()
		for id, e := range s.entries {
			if !e.next.After(now) {
				if late := now.Sub(e.next); late > maxLate {
					slog.Warn("scheduled backup skipped: the scheduler woke up late", "serverId", id, "late", late.Round(time.Second))
				} else {
					due = append(due, dueItem{id, e})
				}
				e.next = e.sched.Next(now)
			}
			if e.next.Before(wakeAt) {
				wakeAt = e.next
			}
		}
		s.mu.Unlock()
		sort.Slice(due, func(i, j int) bool { return due[i].id < due[j].id })
		for _, d := range due {
			// A Remove or Set after the deadline voids the firing (the remaining window
			// is that of a Remove concurrent with the fire call itself).
			s.mu.Lock()
			current := s.entries[d.id] == d.entry
			s.mu.Unlock()
			if current {
				s.fire(d.id)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-s.clock.Until(wakeAt):
		}
	}
}

// ShouldRun decides whether a scheduled backup is made (onlyIfPlayersSince, spec §6.5). It is
// skipped only if: there is a previous backup, the agent has observed the server since before
// that backup and nobody has connected since. lastBackup must be the START of the last
// backup (with the end, a player who joined during the backup would count as earlier and the next
// one would be skipped). PlayerWatch samples every ~10 s: a shorter connection may go unnoticed. When in doubt (agent restarted), it is made.
func ShouldRun(onlyIfPlayersSince bool, lastBackup, playersSeen, watchingSince time.Time) bool {
	if !onlyIfPlayersSince || lastBackup.IsZero() {
		return true
	}
	if watchingSince.After(lastBackup) {
		return true
	}
	return playersSeen.After(lastBackup)
}

// PlayerWatch remembers when any player was last seen on each server (with
// each observed state, every ~10 s). In memory only: Since says since when it observes.
type PlayerWatch struct {
	now   func() time.Time
	since time.Time
	mu    sync.Mutex
	seen  map[string]time.Time
}

// NewPlayerWatch starts observing now.
func NewPlayerWatch(now func() time.Time) *PlayerWatch {
	return &PlayerWatch{now: now, since: now(), seen: map[string]time.Time{}}
}

// Observe records the number of players connected to a server.
func (w *PlayerWatch) Observe(serverID string, playersOnline uint32) {
	if playersOnline == 0 {
		return
	}
	t := w.now()
	w.mu.Lock()
	w.seen[serverID] = t
	w.mu.Unlock()
}

// LastSeen is the last time the server had players (zero if never since Since).
func (w *PlayerWatch) LastSeen(serverID string) time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.seen[serverID]
}

// Since is since when it is observed.
func (w *PlayerWatch) Since() time.Time { return w.since }
