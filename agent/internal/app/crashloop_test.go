package app

import (
	"context"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/crashloop"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

// eventsOf vacía la cola de eventos (marca FIFO) y devuelve los Event que llegaron al sink.
func eventsOf(t *testing.T, a *App, s *sink) []*mcsmv1.Event {
	t.Helper()
	mark := make(chan struct{})
	a.events.ch <- outItem{mark: mark}
	select {
	case <-mark:
	case <-time.After(3 * time.Second):
		t.Fatal("la cola de eventos no avanza")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*mcsmv1.Event
	for _, e := range s.envs {
		if ev := e.GetEvent(); ev != nil {
			out = append(out, ev)
		}
	}
	return out
}

// crashApp: agente con el servidor "a" en marcha y su cola de eventos funcionando.
func crashApp(t *testing.T) (*App, *docker.Fake, *sink, string) {
	t.Helper()
	a, fake, _ := newApp(t)
	s := newSink()
	s.ch = make(chan *mcsmv1.Envelope, 1024)
	a.send = s.send
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a.life = ctx
	go a.events.run(ctx)
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	cid := a.rec.ContainerID(context.Background(), "a")
	if cid == "" {
		t.Fatal("sin contenedor")
	}
	return a, fake, s, cid
}

func die(cid string, code string) docker.Event {
	return docker.Event{Action: "die", ContainerID: cid, Labels: map[string]string{spec.LabelServerID: "a", "exitCode": code}}
}

func TestOnDieIgnoresCleanExitsRequestedStopsAndHeldServers(t *testing.T) {
	a, _, s, cid := crashApp(t)
	a.onDie("a", die(cid, "0"))                                                              // salida limpia (/stop, parada de mc-router)
	a.onDie("a", docker.Event{Action: "die", ContainerID: cid, Labels: map[string]string{}}) // sin exitCode
	a.intents.Note(cid)
	a.onDie("a", die(cid, "143")) // parada pedida por el agente
	release, err := a.rec.Hold("a", "copia")
	if err != nil {
		t.Fatal(err)
	}
	a.onDie("a", docker.Event{Action: "die", ContainerID: "otro", Labels: map[string]string{spec.LabelServerID: "a", "exitCode": "1"}})
	release(context.Background())
	a.onDie("de-otro-agente", die("ajeno", "1")) // servidor que este agente no conoce
	if evs := eventsOf(t, a, s); len(evs) != 0 {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestFourCrashesInAnHourStopAndRetainTheServer(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < crashloop.MaxCrashes+1; i++ {
		a.onDie("a", die(cid, "1"))
	}
	waitBackground(t, a)
	evs := eventsOf(t, a, s)
	var crashes, loops int
	for _, e := range evs {
		switch e.Kind {
		case KindCrash:
			crashes++
			if e.Level != mcsmv1.EventLevel_EVENT_LEVEL_WARN || e.ServerId != "a" || !strings.Contains(e.Message, "código 1") {
				t.Fatalf("crash = %+v", e)
			}
		case KindCrashLoop:
			loops++
			if e.Level != mcsmv1.EventLevel_EVENT_LEVEL_ERROR || !strings.Contains(e.Message, "se ha parado") {
				t.Fatalf("crash_loop = %+v", e)
			}
		}
	}
	if crashes != crashloop.MaxCrashes+1 || loops != 1 {
		t.Fatalf("crashes=%d bucles=%d: %+v", crashes, loops, evs)
	}
	ins, err := fake.Inspect(context.Background(), cid)
	if err != nil || ins.Running {
		t.Fatalf("el servidor debe quedar parado: %+v %v", ins, err)
	}
	if l, _ := a.st.CrashLatch("a"); l == nil || l.Crashes != crashloop.MaxCrashes+1 {
		t.Fatalf("retención = %+v", l)
	}

	// Arrancar a mano levanta la retención y reinicia la cuenta.
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}}}, s.send)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatal("Power start borra la retención")
	}
	if n, _ := a.crashes.Record("a"); n != 1 {
		t.Fatalf("la cuenta empieza de cero: %d", n)
	}
}

func TestDriftReachesTheEventQueue(t *testing.T) {
	a, fake, s, _ := crashApp(t)
	for _, c := range fake.Containers {
		c.Config.Labels[spec.LabelHash] = "cambiado-a-mano"
	}
	if err := a.rec.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	evs := eventsOf(t, a, s)
	if len(evs) != 1 || evs[0].Kind != "drift" || evs[0].Level != mcsmv1.EventLevel_EVENT_LEVEL_WARN {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestStopRequestedThroughTheAgentIsNotACrash(t *testing.T) {
	a, _, s, cid := crashApp(t)
	// New envuelve el motor: la parada que pide el panel queda anotada y su die (143) no cuenta.
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	a.onDie("a", die(cid, "143"))
	for _, e := range eventsOf(t, a, s) {
		t.Fatalf("evento inesperado: %+v", e)
	}
}

func TestEventLoopTurnsOOMAndDieIntoEvents(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.eventLoop(ctx)
	<-fake.Subscribed()
	fake.EmitEvent(docker.Event{Action: "oom", ContainerID: cid, Labels: map[string]string{spec.LabelServerID: "a"}})
	fake.EmitEvent(die(cid, "137"))
	seen := map[string]bool{}
	deadline := time.After(3 * time.Second)
	for !seen[KindOOM] || !seen[KindCrash] {
		select {
		case e := <-s.ch:
			if ev := e.GetEvent(); ev != nil && ev.ServerId == "a" {
				seen[ev.Kind] = true
			}
		case <-deadline:
			t.Fatalf("eventos vistos = %v", seen)
		}
	}
}

// Un CrashLoopStop decidido antes de que el usuario pulse Arrancar no retiene ni para el servidor recién arrancado.
// La parada queda en cola (el semáforo de tareas de fondo lleno) mientras llega el Power start.
func TestQueuedCrashLoopStopYieldsToAManualStart(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < cap(a.sem); i++ { // nada de fondo puede ejecutarse aún
		a.sem <- struct{}{}
	}
	for i := 0; i < crashloop.MaxCrashes+1; i++ {
		a.onDie("a", die(cid, "1"))
	}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART}}}, s.send)
	for i := 0; i < cap(a.sem); i++ {
		<-a.sem
	}
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatalf("retención tras arrancar a mano = %+v", l)
	}
	ins, err := fake.Inspect(context.Background(), a.rec.ContainerID(context.Background(), "a"))
	if err != nil || !ins.Running {
		t.Fatalf("el servidor arrancado a mano sigue en marcha: %+v %v", ins, err)
	}
	for _, e := range eventsOf(t, a, s) {
		if e.Kind == KindCrashLoop || e.Kind == KindCrashLoopFailed {
			t.Fatalf("evento %s de una parada que ya no toca", e.Kind)
		}
	}
}
