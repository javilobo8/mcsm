package crashloop

import (
	"context"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	"mcsm/agent/internal/docker"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func TestTrackerTripsOnFourthCrashWithinAnHour(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	tr := NewTracker(c.now)
	for i := 1; i <= MaxCrashes; i++ {
		if n, tripped := tr.Record("a"); n != i || tripped {
			t.Fatalf("crash %d: n=%d tripped=%v", i, n, tripped)
		}
		c.t = c.t.Add(10 * time.Minute)
	}
	if n, tripped := tr.Record("a"); n != MaxCrashes+1 || !tripped {
		t.Fatalf("the fourth within an hour trips: n=%d tripped=%v", n, tripped)
	}
	if n, tripped := tr.Record("a"); n != 1 || tripped {
		t.Fatalf("after tripping the count starts from zero: n=%d tripped=%v", n, tripped)
	}
	if n, _ := tr.Record("b"); n != 1 {
		t.Fatal("each server counts separately")
	}
}

func TestTrackerForgetsCrashesOlderThanTheWindow(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	tr := NewTracker(c.now)
	for i := 0; i < MaxCrashes; i++ {
		tr.Record("a")
		c.t = c.t.Add(25 * time.Minute) // 0, 25, 50 min
	}
	// 75 min: the one at 0 min no longer counts → 3 in the window, does not trip.
	if n, tripped := tr.Record("a"); n != MaxCrashes || tripped {
		t.Fatalf("n=%d tripped=%v", n, tripped)
	}
	tr.Reset("a")
	if n, _ := tr.Record("a"); n != 1 {
		t.Fatal("Reset forgets the crashes")
	}
}

func TestIntentsAbsorbOneDiePerRequestedStop(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	if in.Consume("c1") {
		t.Fatal("no requested stop")
	}
	in.Note("c1")
	in.Note("") // ignored
	if !in.Consume("c1") {
		t.Fatal("the die of the requested stop is not a crash")
	}
	if in.Consume("c1") {
		t.Fatal("the second die of the same container does count: each stop absorbs only one")
	}
}

func TestIntentsTwoStopsAbsorbTwoDies(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	in.Note("c1")
	in.Note("c2") // another container: not mixed up
	c.t = c.t.Add(time.Minute)
	in.Note("c1")
	for i := 0; i < 2; i++ {
		if !in.Consume("c1") {
			t.Fatalf("die %d: two stops absorb two", i+1)
		}
	}
	if in.Consume("c1") {
		t.Fatal("the third one does count")
	}
	if !in.Consume("c2") {
		t.Fatal("c2's stop is still recorded")
	}
}

func TestIntentsExpireAfterTTL(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	in.Note("c1")
	c.t = c.t.Add(IntentTTL)
	if !in.Consume("c1") {
		t.Fatal("within the deadline it counts as requested")
	}
	in.Note("c1")
	c.t = c.t.Add(IntentTTL + time.Second)
	if in.Consume("c1") {
		t.Fatal("past the deadline it no longer does")
	}
	// An expired note does not linger: a new one works and is the only one.
	in.Note("c1")
	if !in.Consume("c1") || in.Consume("c1") {
		t.Fatal("only the current note absorbs a die")
	}
}

func TestEngineNotesStopKillAndRemove(t *testing.T) {
	ctx := context.Background()
	fake := docker.NewFake()
	in := NewIntents(time.Now)
	eng := Engine{Engine: fake, Intents: in}
	mk := func(name string) string {
		id, err := fake.Create(ctx, name, &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := fake.Start(ctx, id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	a, b, c := mk("mcsm-a"), mk("mcsm-b"), mk("mcsm-c")
	if err := eng.Stop(ctx, a, time.Second); err != nil {
		t.Fatal(err)
	}
	if err := eng.Kill(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := eng.Remove(ctx, c); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{a, b, c} {
		if !in.Consume(id) {
			t.Fatalf("%s: the requested stop must be recorded", id)
		}
	}
	// Everything else passes unchanged to the engine underneath.
	if v, _ := eng.Version(ctx); v != "fake-29.0" {
		t.Fatalf("version = %q", v)
	}
}

func TestExitCode(t *testing.T) {
	for _, tc := range []struct {
		labels map[string]string
		code   int
		ok     bool
	}{
		{map[string]string{"exitCode": "137"}, 137, true},
		{map[string]string{"exitCode": "0"}, 0, true},
		{map[string]string{"exitCode": "x"}, 0, false},
		{map[string]string{}, 0, false},
	} {
		code, ok := ExitCode(docker.Event{Action: "die", Labels: tc.labels})
		if code != tc.code || ok != tc.ok {
			t.Fatalf("%v → %d %v", tc.labels, code, ok)
		}
	}
}

func TestFakeCrash(t *testing.T) {
	ctx := context.Background()
	fake := docker.NewFake()
	id, _ := fake.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	_ = fake.Start(ctx, id)
	fake.Crash(id, 1)
	ins, err := fake.Inspect(ctx, id)
	if err != nil || ins.State != "exited" || ins.ExitCode != 1 || ins.Running {
		t.Fatalf("inspect = %+v %v", ins, err)
	}
}
