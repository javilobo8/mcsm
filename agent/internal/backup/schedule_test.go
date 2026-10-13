package backup

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"
)

type fakeWaiter struct {
	at time.Time
	ch chan time.Time
}

// fakeClock advances by hand. registered receives a notice every time the loop starts waiting.
type fakeClock struct {
	mu         sync.Mutex
	now        time.Time
	waiters    []fakeWaiter
	registered chan struct{}
	untilArgs  []time.Time
}

func newFakeClock(t time.Time) *fakeClock {
	return &fakeClock{now: t, registered: make(chan struct{}, 1024)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Until(at time.Time) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.untilArgs = append(c.untilArgs, at)
	ch := make(chan time.Time, 1)
	if !at.After(c.now) {
		ch <- c.now
	} else {
		c.waiters = append(c.waiters, fakeWaiter{at, ch})
	}
	c.registered <- struct{}{}
	return ch
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	keep := c.waiters[:0]
	for _, w := range c.waiters {
		if !w.at.After(c.now) {
			w.ch <- c.now
		} else {
			keep = append(keep, w)
		}
	}
	c.waiters = keep
}

// waitLoop waits for the loop to sleep again (the timeout is only a safety net).
func (c *fakeClock) waitLoop(t *testing.T) {
	t.Helper()
	select {
	case <-c.registered:
	case <-time.After(2 * time.Second):
		t.Fatal("the scheduler did not wait again")
	}
}

func expectFire(t *testing.T, ch <-chan string, want string) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("fired %s, expected %s", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("%s did not fire", want)
	}
}

func expectNoFire(t *testing.T, ch <-chan string) {
	t.Helper()
	select {
	case got := <-ch:
		t.Fatalf("unexpected firing of %s", got)
	default:
	}
}

func TestSchedulerFiresEveryMinute(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC))
	fired := make(chan string, 10)
	s := NewScheduler(clk, func(id string) { fired <- id })
	if err := s.Set("a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	if next, _ := s.Next("a"); !next.Equal(time.Date(2026, 10, 12, 10, 1, 0, 0, time.UTC)) {
		t.Fatalf("next = %v", next)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(30 * time.Second)
	expectFire(t, fired, "a")
	clk.waitLoop(t)
	clk.Advance(time.Minute)
	expectFire(t, fired, "a")
	clk.waitLoop(t)
	expectNoFire(t, fired)
}

func TestSchedulerDailyAndReschedule(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC))
	fired := make(chan string, 10)
	s := NewScheduler(clk, func(id string) { fired <- id })
	if err := s.Set("b", "0 4 * * *"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(time.Hour) // 11:00:30: nothing to do
	clk.waitLoop(t)
	expectNoFire(t, fired)
	clk.Advance(17 * time.Hour) // 04:00:30 the next day
	expectFire(t, fired, "b")
	clk.waitLoop(t)

	before, _ := s.Next("b")
	if err := s.Set("b", "0 4 * * *"); err != nil { // same expression: changes nothing
		t.Fatal(err)
	}
	if after, _ := s.Next("b"); !after.Equal(before) {
		t.Fatalf("the same expression must not reschedule: %v → %v", before, after)
	}
	if err := s.Set("b", "*/5 * * * *"); err != nil { // wakes the loop
		t.Fatal(err)
	}
	clk.waitLoop(t)
	if next, _ := s.Next("b"); !next.Equal(time.Date(2026, 10, 13, 4, 5, 0, 0, time.UTC)) {
		t.Fatalf("next after rescheduling = %v", next)
	}
	if err := s.Set("b", "every day"); err == nil {
		t.Fatal("invalid expression")
	}
	s.Remove("b")
	clk.waitLoop(t)
	if ids := s.IDs(); len(ids) != 0 {
		t.Fatalf("ids = %v", ids)
	}
	clk.Advance(10 * time.Minute)
	clk.waitLoop(t)
	expectNoFire(t, fired)
}

func TestShouldRun(t *testing.T) {
	start := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	last := start.Add(time.Hour)
	cases := []struct {
		name          string
		only          bool
		last, seen, w time.Time
		want          bool
	}{
		{"without onlyIfPlayersSince always", false, last, time.Time{}, start, true},
		{"first backup", true, time.Time{}, time.Time{}, start, true},
		{"nobody since the last", true, last, time.Time{}, start, false},
		{"players before the last", true, last, last.Add(-time.Minute), start, false},
		{"players after the last", true, last, last.Add(time.Minute), start, true},
		{"agent restarted after the last", true, last, time.Time{}, last.Add(time.Minute), true},
	}
	for _, c := range cases {
		if got := ShouldRun(c.only, c.last, c.seen, c.w); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}

func TestPlayerWatch(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	w := NewPlayerWatch(func() time.Time { return now })
	if !w.Since().Equal(now) || !w.LastSeen("a").IsZero() {
		t.Fatal("initial state")
	}
	now = now.Add(time.Minute)
	w.Observe("a", 0)
	if !w.LastSeen("a").IsZero() {
		t.Fatal("0 players does not count")
	}
	w.Observe("a", 2)
	if !w.LastSeen("a").Equal(now) {
		t.Fatalf("LastSeen = %v", w.LastSeen("a"))
	}
}

func TestSchedulerStopsWithContext(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s := NewScheduler(clk, func(string) {})
	if err := s.Set("a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	clk.waitLoop(t)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not finish when the context was cancelled")
	}
}

func TestSchedulerEmptyExprUnschedules(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	s := NewScheduler(clk, func(string) {})
	if err := s.Set("a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("a", ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Next("a"); ok || len(s.IDs()) != 0 {
		t.Fatal("Set(\"\") must unschedule")
	}
	// An invalid expression does not overwrite the current schedule.
	if err := s.Set("b", "0 4 * * *"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("b", "nope"); err == nil {
		t.Fatal("invalid expression")
	}
	if _, ok := s.Next("b"); !ok {
		t.Fatal("the previous schedule must remain")
	}
}

func TestSchedulerMultipleServersDueTogether(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	fired := make(chan string, 10)
	s := NewScheduler(clk, func(id string) { fired <- id })
	for _, id := range []string{"b", "a"} {
		if err := s.Set(id, "*/10 * * * *"); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(10 * time.Minute)
	expectFire(t, fired, "a")
	expectFire(t, fired, "b")
}

// Set concurrent with the firings: it must be clean under -race and not lose the loop.
func TestSchedulerConcurrentSetAndFire(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	fired := make(chan string, 4096)
	s := NewScheduler(clk, func(id string) { fired <- id })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	clk.waitLoop(t)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			expr := "* * * * *"
			if i%2 == 1 {
				expr = "*/2 * * * *"
			}
			_ = s.Set("a", expr)
			if i%10 == 9 {
				s.Remove("a")
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			clk.Advance(time.Minute)
			s.IDs()
			s.Next("a")
		}
	}()
	wg.Wait()
	// After the storm the scheduler is still alive: it only fires "a" and does so on time.
	if err := s.Set("a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	for len(fired) > 0 {
		<-fired
	}
	clk.Advance(time.Minute)
	expectFire(t, fired, "a")
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not finish")
	}
	if ids := s.IDs(); len(ids) != 1 || ids[0] != "a" {
		t.Fatalf("ids = %v", ids)
	}
}

// Set validates the same as the panel (proto/fixtures/cron-cases.json) and does not accept what only
// cron.ParseStandard tolerates (@daily, CRON_TZ, names).
func TestSchedulerSetMatchesPanelFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../proto/fixtures/cron-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases struct{ Valid, Invalid []string }
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	s := NewScheduler(newFakeClock(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)), func(string) {})
	for _, e := range cases.Valid {
		if err := s.Set("x", e); err != nil {
			t.Errorf("Set(%q) should accept it: %v", e, err)
		}
	}
	for _, e := range cases.Invalid {
		if e == "" {
			continue // "" unschedules, it is not an error
		}
		if err := s.Set("y", e); err == nil {
			t.Errorf("Set(%q) should reject it", e)
		}
	}
	for _, e := range []string{"@daily", "@every 1h", "CRON_TZ=UTC 0 4 * * *"} {
		if err := s.Set("z", e); err == nil {
			t.Errorf("Set(%q) should reject it", e)
		}
	}
}

// Go and JS differ on whitespace (U+0085, U+FEFF): the panel and the agent reject
// everything that is not printable ASCII, space or tab (it is also in the fixture).
func TestSchedulerSetRejectsNonASCIIWhitespace(t *testing.T) {
	s := NewScheduler(newFakeClock(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)), func(string) {})
	for _, e := range []string{"0\u00854 * * *", "0\ufeff4 * * *", "\ufeff0 4 * * *", "0\u00a04 * * *"} {
		if err := s.Set("a", e); err == nil {
			t.Errorf("Set(%q) should reject it", e)
		}
	}
}

func TestSchedulerNormalizesExpression(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC))
	s := NewScheduler(clk, func(string) {})
	if err := s.Set("a", "*/5 * * * *"); err != nil {
		t.Fatal(err)
	}
	clk.Advance(time.Minute)
	before, _ := s.Next("a")
	if err := s.Set("a", "  */5\t *  * * * "); err != nil {
		t.Fatal(err)
	}
	if after, _ := s.Next("a"); !after.Equal(before) {
		t.Fatalf("a variant with extra spaces must not reschedule: %v → %v", before, after)
	}
}

// A Remove done by fire (or by another thread) between the deadline and the firing is respected.
func TestSchedulerRemoveBetweenDueAndFire(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	fired := make(chan string, 10)
	var s *Scheduler
	s = NewScheduler(clk, func(id string) {
		fired <- id
		if id == "a" {
			s.Remove("b")
		}
	})
	for _, id := range []string{"a", "b"} {
		if err := s.Set(id, "*/10 * * * *"); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(10 * time.Minute)
	expectFire(t, fired, "a")
	clk.waitLoop(t)
	expectNoFire(t, fired)
}

// Set on an already collected overdue entry: the old entry does not fire.
func TestSchedulerSetReplacesDueEntry(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC))
	fired := make(chan string, 10)
	var s *Scheduler
	s = NewScheduler(clk, func(id string) {
		fired <- id
		if id == "a" {
			_ = s.Set("b", "0 5 * * *")
		}
	})
	for _, id := range []string{"a", "b"} {
		if err := s.Set(id, "*/10 * * * *"); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(10 * time.Minute)
	expectFire(t, fired, "a")
	clk.waitLoop(t)
	expectNoFire(t, fired)
}

// After suspending the machine, a run missed by more than maxLate is not recovered.
func TestSchedulerSkipsLateFire(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC))
	fired := make(chan string, 10)
	s := NewScheduler(clk, func(id string) { fired <- id })
	if err := s.Set("a", "0 4 * * *"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(20 * time.Hour) // 06:00:30 on the 13th: the 04:00 firing arrives 2 h late
	// Set's poke may leave an old wait notice: wait until the rescheduling is seen.
	want := time.Date(2026, 10, 14, 4, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		if next, _ := s.Next("a"); next.Equal(want) {
			break
		}
		clk.waitLoop(t)
	}
	expectNoFire(t, fired)
	if next, _ := s.Next("a"); !next.Equal(want) {
		t.Fatalf("next = %v", next)
	}
	// A firing with little lateness does happen.
	clk.Advance(22 * time.Hour) // 04:00:30 on the 14th
	expectFire(t, fired, "a")
}

func TestSchedulerWaitIsBounded(t *testing.T) {
	start := time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC)
	clk := newFakeClock(start)
	s := NewScheduler(clk, func(string) {})
	if err := s.Set("a", "0 4 * * *"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.mu.Lock()
	got := clk.untilArgs[len(clk.untilArgs)-1]
	clk.mu.Unlock()
	if !got.Equal(start.Add(time.Minute)) {
		t.Fatalf("waits until %v, expected %v", got, start.Add(time.Minute))
	}
}

// A clock jump backwards does not cause duplicate firings.
func TestSchedulerClockJumpsBack(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 10, 12, 10, 0, 30, 0, time.UTC))
	fired := make(chan string, 10)
	s := NewScheduler(clk, func(id string) { fired <- id })
	if err := s.Set("a", "* * * * *"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	clk.waitLoop(t)
	clk.Advance(30 * time.Second) // 10:01:00
	expectFire(t, fired, "a")
	clk.waitLoop(t)
	clk.Advance(-time.Hour)
	clk.Advance(time.Hour) // goes back to 10:01:00
	expectNoFire(t, fired)
	clk.Advance(time.Minute)
	expectFire(t, fired, "a")
}
