package app

import (
	"context"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/crashloop"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
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
	fake := docker.NewFake()
	a, s, cid := crashAppEngine(t, fake)
	return a, fake, s, cid
}

// crashAppEngine es crashApp sobre un Engine cualquiera (envoltorios del fake).
func crashAppEngine(t *testing.T, eng docker.Engine) (*App, *sink, string) {
	t.Helper()
	a, _ := newAppEngine(t, eng)
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
	return a, s, cid
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

// m6: cada parada pedida explica un solo die del contenedor (también uno limpio); los siguientes son crashes. Así
// un bucle que empieza justo tras un Reiniciar se cuenta desde el primer cierre con error.
func TestRequestedStopAbsorbsOnlyOneDie(t *testing.T) {
	a, _, s, cid := crashApp(t)
	a.intents.Note(cid)
	a.onDie("a", die(cid, "143")) // la parada pedida
	a.onDie("a", die(cid, "1"))   // el siguiente ya es un crash
	a.intents.Note(cid)
	a.onDie("a", die(cid, "0")) // parada pedida con salida limpia: gasta la anotación igualmente
	a.onDie("a", die(cid, "1"))
	evs := eventsOf(t, a, s)
	if len(evs) != 2 || evs[0].Kind != KindCrash || evs[1].Kind != KindCrash || !strings.Contains(evs[1].Message, "2 en la última hora") {
		t.Fatalf("eventos = %+v", evs)
	}
}

// m10(c): la hora de los Event sale del reloj inyectable del agente (el de las copias), no de time.Now.
func TestEventsUseTheAgentClock(t *testing.T) {
	a, _, s, cid := crashApp(t)
	at := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	a.bk.clock = &manualClock{now: at}
	a.onDie("a", die(cid, "1"))
	if evs := eventsOf(t, a, s); len(evs) != 1 || evs[0].TsUnixMs != at.UnixMilli() {
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
	runEventLoop(t, a)
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

// N1: si una parada por bucle sigue en cola cuando llega otro disparo (tras un Arrancar del usuario), la fusión de
// dispatch no la ejecuta con lo decidido la primera vez (gen viejo, descartado): usa la última decisión.
func TestCoalescedCrashLoopStopUsesTheLatestDecision(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < cap(a.sem); i++ {
		a.sem <- struct{}{}
	}
	for i := 0; i < crashloop.MaxCrashes+1; i++ { // primer disparo: queda en cola
		a.onDie("a", die(cid, "1"))
	}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART}}}, s.send)
	cid = a.rec.ContainerID(context.Background(), "a")
	for i := 0; i < crashloop.MaxCrashes+1; i++ { // el servidor arrancado a mano vuelve a entrar en bucle
		// Otro id en el evento: el die de la parada del reinicio queda anotado en Intents con el id del contenedor.
		a.onDie("a", die("tras-arrancar", "1"))
	}
	for i := 0; i < cap(a.sem); i++ {
		<-a.sem
	}
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l == nil {
		t.Fatal("el segundo bucle (posterior al Arrancar) retiene el servidor")
	}
	if ins, err := fake.Inspect(context.Background(), cid); err != nil || ins.Running {
		t.Fatalf("y lo para: %+v %v", ins, err)
	}
	loops := 0
	for _, e := range eventsOf(t, a, s) {
		if e.Kind == KindCrashLoop {
			loops++
		}
	}
	if loops != 1 {
		t.Fatalf("eventos crash_loop = %d", loops)
	}
}

// startHook llama a onStart antes de cada Start del motor de debajo.
type startHook struct {
	docker.Engine
	onStart func()
}

func (e *startHook) Start(ctx context.Context, id string) error {
	if f := e.onStart; f != nil {
		f()
	}
	return e.Engine.Start(ctx, id)
}

// OOS1: la cuenta de crashes empieza de cero ANTES del arranque manual: un cierre con error que llegue mientras el
// Power está en curso no se suma a los de antes (no dispararía con la generación nueva y retendría el servidor que
// el usuario acaba de arrancar).
func TestManualStartResetsTheCountBeforeStarting(t *testing.T) {
	hook := &startHook{Engine: docker.NewFake()}
	a, s, cid := crashAppEngine(t, hook)
	for i := 0; i < crashloop.MaxCrashes; i++ {
		a.onDie("a", die(cid, "1"))
	}
	hook.onStart = func() { a.onDie("a", die("durante-el-arranque", "1")) }
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART}}}, s.send)
	hook.onStart = nil
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatalf("retención del servidor recién arrancado = %+v", l)
	}
	if n, _ := a.crashes.Record("a"); n != 2 {
		t.Fatalf("la cuenta tras Arrancar = %d (el cierre durante el arranque y este)", n)
	}
}

// m10(b): un Arrancar que no se acepta (servidor reservado: busy) no reinicia la cuenta de crashes.
func TestRejectedManualStartKeepsTheCrashCount(t *testing.T) {
	a, _, s, cid := crashApp(t)
	for i := 0; i < crashloop.MaxCrashes; i++ {
		a.onDie("a", die(cid, "1"))
	}
	release, err := a.rec.Hold("a", "copia")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}}}, s.send)
	release(context.Background())
	if r := s.waitID(t, 9); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("respuesta = %+v", r)
	}
	if n, tripped := a.crashes.Record("a"); n != crashloop.MaxCrashes+1 || !tripped {
		t.Fatalf("la cuenta tras un Arrancar rechazado = %d (tripped=%v)", n, tripped)
	}
}

// OOS2: una parada por bucle decidida antes de que llegue una versión nueva de la spec (p. ej. más memoria) no
// retiene esa versión nueva: la configuración nueva se prueba.
func TestQueuedCrashLoopStopYieldsToANewSpecVersion(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < cap(a.sem); i++ {
		a.sem <- struct{}{}
	}
	for i := 0; i < crashloop.MaxCrashes+1; i++ {
		a.onDie("a", die(cid, "1"))
	}
	v2 := specMsg("a", "alpha", 2)
	v2.SpecJson = []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: v2}}}, s.send)
	for i := 0; i < cap(a.sem); i++ {
		<-a.sem
	}
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatalf("retención de la versión nueva = %+v", l)
	}
	ins, err := fake.Inspect(context.Background(), a.rec.ContainerID(context.Background(), "a"))
	if err != nil || !ins.Running {
		t.Fatalf("la versión nueva sigue en marcha: %+v %v", ins, err)
	}
}
