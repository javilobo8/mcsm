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
		t.Fatalf("el cuarto en una hora dispara: n=%d tripped=%v", n, tripped)
	}
	if n, tripped := tr.Record("a"); n != 1 || tripped {
		t.Fatalf("tras disparar la cuenta empieza de cero: n=%d tripped=%v", n, tripped)
	}
	if n, _ := tr.Record("b"); n != 1 {
		t.Fatal("cada servidor cuenta aparte")
	}
}

func TestTrackerForgetsCrashesOlderThanTheWindow(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	tr := NewTracker(c.now)
	for i := 0; i < MaxCrashes; i++ {
		tr.Record("a")
		c.t = c.t.Add(25 * time.Minute) // 0, 25, 50 min
	}
	// 75 min: el de 0 min ya no cuenta → 3 en la ventana, no dispara.
	if n, tripped := tr.Record("a"); n != MaxCrashes || tripped {
		t.Fatalf("n=%d tripped=%v", n, tripped)
	}
	tr.Reset("a")
	if n, _ := tr.Record("a"); n != 1 {
		t.Fatal("Reset olvida los crashes")
	}
}

func TestIntentsAbsorbOneDiePerRequestedStop(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	if in.Consume("c1") {
		t.Fatal("sin parada pedida")
	}
	in.Note("c1")
	in.Note("") // ignorado
	if !in.Consume("c1") {
		t.Fatal("el die de la parada pedida no es un crash")
	}
	if in.Consume("c1") {
		t.Fatal("el segundo die del mismo contenedor ya cuenta: cada parada absorbe uno solo")
	}
}

func TestIntentsTwoStopsAbsorbTwoDies(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	in.Note("c1")
	in.Note("c2") // otro contenedor: no se mezcla
	c.t = c.t.Add(time.Minute)
	in.Note("c1")
	for i := 0; i < 2; i++ {
		if !in.Consume("c1") {
			t.Fatalf("die %d: dos paradas absorben dos", i+1)
		}
	}
	if in.Consume("c1") {
		t.Fatal("el tercero ya cuenta")
	}
	if !in.Consume("c2") {
		t.Fatal("la parada de c2 sigue anotada")
	}
}

func TestIntentsExpireAfterTTL(t *testing.T) {
	c := &clock{t: time.Unix(1_000_000, 0)}
	in := NewIntents(c.now)
	in.Note("c1")
	c.t = c.t.Add(IntentTTL)
	if !in.Consume("c1") {
		t.Fatal("dentro del plazo cuenta como pedida")
	}
	in.Note("c1")
	c.t = c.t.Add(IntentTTL + time.Second)
	if in.Consume("c1") {
		t.Fatal("pasado el plazo ya no")
	}
	// Una anotación caducada no se queda: una nueva vale y es la única.
	in.Note("c1")
	if !in.Consume("c1") || in.Consume("c1") {
		t.Fatal("solo la anotación vigente absorbe un die")
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
			t.Fatalf("%s: la parada pedida debe quedar anotada", id)
		}
	}
	// Lo demás pasa tal cual al motor de debajo.
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
