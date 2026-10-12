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
	// Tras la tormenta el planificador sigue vivo: solo dispara "a" y lo hace al vencer.
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
		t.Fatal("Run no terminó")
	}
	if ids := s.IDs(); len(ids) != 1 || ids[0] != "a" {
		t.Fatalf("ids = %v", ids)
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

// Go y JS difieren en el espacio en blanco (U+0085, U+FEFF): el panel y el agente rechazan
// todo lo que no sea ASCII imprimible, espacio o tabulador (también está en el fixture).
func TestSchedulerSetRejectsNonASCIIWhitespace(t *testing.T) {
	s := NewScheduler(newFakeClock(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)), func(string) {})
	for _, e := range []string{"0\u00854 * * *", "0\ufeff4 * * *", "\ufeff0 4 * * *", "0\u00a04 * * *"} {
		if err := s.Set("a", e); err == nil {
			t.Errorf("Set(%q) debería rechazarla", e)
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
		t.Fatalf("una variante con espacios no debe reprogramar: %v → %v", before, after)
	}
}

// Un Remove hecho por fire (o por otro hilo) entre el vencimiento y el disparo se respeta.
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

// Set sobre una entrada vencida ya recogida: la entrada vieja no dispara.
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

// Tras suspender el equipo, una ejecución perdida por más de maxLate no se recupera.
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
	clk.Advance(20 * time.Hour) // 06:00:30 del 13: el disparo de las 04:00 llega 2 h tarde
	// El poke de Set puede dejar un aviso de espera antiguo: espera hasta ver la reprogramación.
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
	// Un disparo con poca tardanza sí se hace.
	clk.Advance(22 * time.Hour) // 04:00:30 del 14
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
		t.Fatalf("espera hasta %v, esperaba %v", got, start.Add(time.Minute))
	}
}

// Un salto del reloj hacia atrás no provoca disparos duplicados.
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
	clk.Advance(time.Hour) // vuelve a 10:01:00
	expectNoFire(t, fired)
	clk.Advance(time.Minute)
	expectFire(t, fired, "a")
}
