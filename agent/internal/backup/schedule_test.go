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

// fakeClock avanza a mano. registered recibe un aviso cada vez que el bucle se pone a esperar.
type fakeClock struct {
	mu         sync.Mutex
	now        time.Time
	waiters    []fakeWaiter
	registered chan struct{}
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

// waitLoop espera a que el bucle vuelva a dormir (el timeout es solo una red de seguridad).
func (c *fakeClock) waitLoop(t *testing.T) {
	t.Helper()
	select {
	case <-c.registered:
	case <-time.After(2 * time.Second):
		t.Fatal("el planificador no volvió a esperar")
	}
}

func expectFire(t *testing.T, ch <-chan string, want string) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("disparó %s, esperaba %s", got, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no se disparó %s", want)
	}
}

func expectNoFire(t *testing.T, ch <-chan string) {
	t.Helper()
	select {
	case got := <-ch:
		t.Fatalf("disparo inesperado de %s", got)
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
	clk.Advance(time.Hour) // 11:00:30: nada que hacer
	clk.waitLoop(t)
	expectNoFire(t, fired)
	clk.Advance(17 * time.Hour) // 04:00:30 del día siguiente
	expectFire(t, fired, "b")
	clk.waitLoop(t)

	before, _ := s.Next("b")
	if err := s.Set("b", "0 4 * * *"); err != nil { // misma expresión: no cambia nada
		t.Fatal(err)
	}
	if after, _ := s.Next("b"); !after.Equal(before) {
		t.Fatalf("misma expresión no debe reprogramar: %v → %v", before, after)
	}
	if err := s.Set("b", "*/5 * * * *"); err != nil { // despierta al bucle
		t.Fatal(err)
	}
	clk.waitLoop(t)
	if next, _ := s.Next("b"); !next.Equal(time.Date(2026, 10, 13, 4, 5, 0, 0, time.UTC)) {
		t.Fatalf("next tras reprogramar = %v", next)
	}
	if err := s.Set("b", "cada día"); err == nil {
		t.Fatal("expresión inválida")
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
		{"sin onlyIfPlayersSince siempre", false, last, time.Time{}, start, true},
		{"primera copia", true, time.Time{}, time.Time{}, start, true},
		{"nadie desde la última", true, last, time.Time{}, start, false},
		{"jugadores antes de la última", true, last, last.Add(-time.Minute), start, false},
		{"jugadores después de la última", true, last, last.Add(time.Minute), start, true},
		{"agente reiniciado tras la última", true, last, time.Time{}, last.Add(time.Minute), true},
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
		t.Fatal("estado inicial")
	}
	now = now.Add(time.Minute)
	w.Observe("a", 0)
	if !w.LastSeen("a").IsZero() {
		t.Fatal("0 jugadores no cuenta")
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
		t.Fatal("Run no terminó al cancelar el contexto")
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
		t.Fatal("Set(\"\") debe desprogramar")
	}
	// Una expresión inválida no pisa la programación vigente.
	if err := s.Set("b", "0 4 * * *"); err != nil {
		t.Fatal(err)
	}
	if err := s.Set("b", "nope"); err == nil {
		t.Fatal("expresión inválida")
	}
	if _, ok := s.Next("b"); !ok {
		t.Fatal("la programación anterior debe seguir")
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

// Set concurrente con los disparos: debe ser limpio bajo -race y no perder el bucle.
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
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run no terminó")
	}
}

// Set valida igual que el panel (proto/fixtures/cron-cases.json) y no acepta lo que solo
// cron.ParseStandard tolera (@daily, CRON_TZ, nombres).
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
			t.Errorf("Set(%q) debería aceptarla: %v", e, err)
		}
	}
	for _, e := range cases.Invalid {
		if e == "" {
			continue // "" desprograma, no es un error
		}
		if err := s.Set("y", e); err == nil {
			t.Errorf("Set(%q) debería rechazarla", e)
		}
	}
	for _, e := range []string{"@daily", "@every 1h", "CRON_TZ=UTC 0 4 * * *"} {
		if err := s.Set("z", e); err == nil {
			t.Errorf("Set(%q) debería rechazarla", e)
		}
	}
}

// Divergencia conocida Go/JS en el espacio en blanco (Task 2): strings.Fields trata U+0085
// como separador y no U+FEFF; /\s+/ de JS al revés. El agente es la última palabra: lo que
// el panel deje pasar con U+FEFF el agente lo rechaza (error al aplicar la spec, nunca una
// programación equivocada), y U+0085, que el panel rechaza, nunca llega.
func TestSchedulerSetWhitespaceDivergence(t *testing.T) {
	s := NewScheduler(newFakeClock(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)), func(string) {})
	if err := s.Set("a", "0\u00854 * * *"); err != nil {
		t.Errorf("U+0085 separa campos en Go: %v", err)
	}
	if err := s.Set("b", "0\ufeff4 * * *"); err == nil {
		t.Error("U+FEFF no es separador en Go: debe rechazarse")
	}
}
