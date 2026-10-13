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

// eventsOf drains the event queue (FIFO mark) and returns the Events that reached the sink.
func eventsOf(t *testing.T, a *App, s *sink) []*mcsmv1.Event {
	t.Helper()
	mark := make(chan struct{})
	a.events.ch <- outItem{mark: mark}
	select {
	case <-mark:
	case <-time.After(3 * time.Second):
		t.Fatal("the event queue does not advance")
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

// crashApp: agent with server "a" running and its event queue working.
func crashApp(t *testing.T) (*App, *docker.Fake, *sink, string) {
	t.Helper()
	fake := docker.NewFake()
	a, s, cid := crashAppEngine(t, fake)
	return a, fake, s, cid
}

// crashAppEngine is crashApp over any Engine (fake wrappers).
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
		t.Fatal("no container")
	}
	return a, s, cid
}

func die(cid string, code string) docker.Event {
	return docker.Event{Action: "die", ContainerID: cid, Labels: map[string]string{spec.LabelServerID: "a", "exitCode": code}}
}

func TestOnDieIgnoresCleanExitsRequestedStopsAndHeldServers(t *testing.T) {
	a, _, s, cid := crashApp(t)
	a.onDie("a", die(cid, "0"))                                                              // clean exit (/stop, mc-router stop)
	a.onDie("a", docker.Event{Action: "die", ContainerID: cid, Labels: map[string]string{}}) // without exitCode
	a.intents.Note(cid)
	a.onDie("a", die(cid, "143")) // stop requested by the agent
	release, err := a.rec.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	a.onDie("a", docker.Event{Action: "die", ContainerID: "other", Labels: map[string]string{spec.LabelServerID: "a", "exitCode": "1"}})
	release(context.Background())
	a.onDie("from-other-agent", die("foreign", "1")) // a server this agent does not know
	if evs := eventsOf(t, a, s); len(evs) != 0 {
		t.Fatalf("events = %+v", evs)
	}
}

// m6: each requested stop explains a single die of the container (also a clean one); the following ones are crashes. This way
// a loop that starts right after a Restart is counted from the first exit with an error.
func TestRequestedStopAbsorbsOnlyOneDie(t *testing.T) {
	a, _, s, cid := crashApp(t)
	a.intents.Note(cid)
	a.onDie("a", die(cid, "143")) // the requested stop
	a.onDie("a", die(cid, "1"))   // the next one is already a crash
	a.intents.Note(cid)
	a.onDie("a", die(cid, "0")) // requested stop with a clean exit: it spends the note all the same
	a.onDie("a", die(cid, "1"))
	evs := eventsOf(t, a, s)
	if len(evs) != 2 || evs[0].Kind != KindCrash || evs[1].Kind != KindCrash || !strings.Contains(evs[1].Message, "2 in the last hour") {
		t.Fatalf("events = %+v", evs)
	}
}

// m10(c): the Events' time comes from the agent's injectable clock (the backups' one), not from time.Now.
func TestEventsUseTheAgentClock(t *testing.T) {
	a, _, s, cid := crashApp(t)
	at := time.Date(2026, 10, 12, 4, 0, 0, 0, time.UTC)
	a.bk.clock = &manualClock{now: at}
	a.onDie("a", die(cid, "1"))
	if evs := eventsOf(t, a, s); len(evs) != 1 || evs[0].TsUnixMs != at.UnixMilli() {
		t.Fatalf("events = %+v", evs)
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
			if e.Level != mcsmv1.EventLevel_EVENT_LEVEL_WARN || e.ServerId != "a" || !strings.Contains(e.Message, "code 1") {
				t.Fatalf("crash = %+v", e)
			}
		case KindCrashLoop:
			loops++
			if e.Level != mcsmv1.EventLevel_EVENT_LEVEL_ERROR || !strings.Contains(e.Message, "has been stopped") {
				t.Fatalf("crash_loop = %+v", e)
			}
		}
	}
	if crashes != crashloop.MaxCrashes+1 || loops != 1 {
		t.Fatalf("crashes=%d loops=%d: %+v", crashes, loops, evs)
	}
	ins, err := fake.Inspect(context.Background(), cid)
	if err != nil || ins.Running {
		t.Fatalf("the server must end up stopped: %+v %v", ins, err)
	}
	if l, _ := a.st.CrashLatch("a"); l == nil || l.Crashes != crashloop.MaxCrashes+1 {
		t.Fatalf("latch = %+v", l)
	}

	// Starting by hand lifts the latch and resets the count.
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}}}, s.send)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatal("Power start deletes the latch")
	}
	if n, _ := a.crashes.Record("a"); n != 1 {
		t.Fatalf("the count starts from zero: %d", n)
	}
}

func TestDriftReachesTheEventQueue(t *testing.T) {
	a, fake, s, _ := crashApp(t)
	for _, c := range fake.Containers {
		c.Config.Labels[spec.LabelHash] = "changed-by-hand"
	}
	if err := a.rec.Reconcile(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	evs := eventsOf(t, a, s)
	if len(evs) != 1 || evs[0].Kind != "drift" || evs[0].Level != mcsmv1.EventLevel_EVENT_LEVEL_WARN {
		t.Fatalf("events = %+v", evs)
	}
}

func TestStopRequestedThroughTheAgentIsNotACrash(t *testing.T) {
	a, _, s, cid := crashApp(t)
	// New wraps the engine: the stop the panel requests is recorded and its die (143) does not count.
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_STOP}}}, s.send)
	a.onDie("a", die(cid, "143"))
	for _, e := range eventsOf(t, a, s) {
		t.Fatalf("unexpected event: %+v", e)
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
			t.Fatalf("events seen = %v", seen)
		}
	}
}

// A CrashLoopStop decided before the user presses Start neither latches nor stops the freshly started server.
// The stop stays queued (the background tasks semaphore full) while the Power start arrives.
func TestQueuedCrashLoopStopYieldsToAManualStart(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < cap(a.sem); i++ { // nothing in the background can run yet
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
		t.Fatalf("latch after starting by hand = %+v", l)
	}
	ins, err := fake.Inspect(context.Background(), a.rec.ContainerID(context.Background(), "a"))
	if err != nil || !ins.Running {
		t.Fatalf("the server started by hand stays running: %+v %v", ins, err)
	}
	for _, e := range eventsOf(t, a, s) {
		if e.Kind == KindCrashLoop || e.Kind == KindCrashLoopFailed {
			t.Fatalf("event %s of a stop that no longer applies", e.Kind)
		}
	}
}

// N1: if a loop stop is still queued when another firing arrives (after a user Start), dispatch's
// merge does not run it with what was decided the first time (old gen, discarded): it uses the last decision.
func TestCoalescedCrashLoopStopUsesTheLatestDecision(t *testing.T) {
	a, fake, s, cid := crashApp(t)
	for i := 0; i < cap(a.sem); i++ {
		a.sem <- struct{}{}
	}
	for i := 0; i < crashloop.MaxCrashes+1; i++ { // first firing: it stays queued
		a.onDie("a", die(cid, "1"))
	}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART}}}, s.send)
	cid = a.rec.ContainerID(context.Background(), "a")
	for i := 0; i < crashloop.MaxCrashes+1; i++ { // the server started by hand enters a loop again
		// Another id in the event: the die of the restart's stop is recorded in Intents with the container's id.
		a.onDie("a", die("after-start", "1"))
	}
	for i := 0; i < cap(a.sem); i++ {
		<-a.sem
	}
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l == nil {
		t.Fatal("the second loop (after the Start) latches the server")
	}
	if ins, err := fake.Inspect(context.Background(), cid); err != nil || ins.Running {
		t.Fatalf("and stops it: %+v %v", ins, err)
	}
	loops := 0
	for _, e := range eventsOf(t, a, s) {
		if e.Kind == KindCrashLoop {
			loops++
		}
	}
	if loops != 1 {
		t.Fatalf("crash_loop events = %d", loops)
	}
}

// startHook calls onStart before each Start of the engine underneath.
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

// OOS1: the crash count starts from zero BEFORE the manual start: an error exit that arrives while the
// Power is in progress is not added to the earlier ones (it would not trip with the new generation and would latch the server
// the user just started).
func TestManualStartResetsTheCountBeforeStarting(t *testing.T) {
	hook := &startHook{Engine: docker.NewFake()}
	a, s, cid := crashAppEngine(t, hook)
	for i := 0; i < crashloop.MaxCrashes; i++ {
		a.onDie("a", die(cid, "1"))
	}
	hook.onStart = func() { a.onDie("a", die("during-start", "1")) }
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART}}}, s.send)
	hook.onStart = nil
	waitBackground(t, a)
	if l, _ := a.st.CrashLatch("a"); l != nil {
		t.Fatalf("latch of the freshly started server = %+v", l)
	}
	if n, _ := a.crashes.Record("a"); n != 2 {
		t.Fatalf("the count after Start = %d (the exit during the start and this one)", n)
	}
}

// m10(b): a Start that is not accepted (reserved server: busy) does not reset the crash count.
func TestRejectedManualStartKeepsTheCrashCount(t *testing.T) {
	a, _, s, cid := crashApp(t)
	for i := 0; i < crashloop.MaxCrashes; i++ {
		a.onDie("a", die(cid, "1"))
	}
	release, err := a.rec.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_PowerAction{PowerAction: &mcsmv1.PowerAction{ServerId: "a", Action: mcsmv1.PowerActionType_POWER_ACTION_TYPE_START}}}, s.send)
	release(context.Background())
	if r := s.waitID(t, 9); r.GetError().GetCode() != errcode.Busy {
		t.Fatalf("response = %+v", r)
	}
	if n, tripped := a.crashes.Record("a"); n != crashloop.MaxCrashes+1 || !tripped {
		t.Fatalf("the count after a rejected Start = %d (tripped=%v)", n, tripped)
	}
}

// OOS2: a loop stop decided before a new spec version arrives (e.g. more memory) does not
// latch that new version: the new configuration is tried.
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
		t.Fatalf("latch of the new version = %+v", l)
	}
	ins, err := fake.Inspect(context.Background(), a.rec.ContainerID(context.Background(), "a"))
	if err != nil || !ins.Running {
		t.Fatalf("the new version stays running: %+v %v", ins, err)
	}
}
