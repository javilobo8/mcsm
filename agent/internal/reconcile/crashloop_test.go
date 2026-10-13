package reconcile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const running = mcsmv1.DesiredState_DESIRED_STATE_RUNNING

func state(t *testing.T, r *Reconciler, id string) string {
	t.Helper()
	c, err := r.Container(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if c == nil {
		return "missing"
	}
	return c.State
}

func TestCrashLoopStopRetainsUntilPowerStart(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	if got := state(t, r, "a"); got != "exited" {
		t.Fatalf("state after the stop = %s", got)
	}
	if o := rec.get("a"); o == nil || !strings.Contains(o.Error, "crash loop") {
		t.Fatalf("observed = %+v", o)
	}
	starts := calls(fake, "Start ")
	// Neither the tick nor a SyncSpecs with the same version and "running" start it.
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: running, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Start ") != starts || state(t, r, "a") != "exited" {
		t.Fatal("a latched server is not started")
	}
	if o := rec.get("a"); !strings.Contains(o.Error, "crash loop") {
		t.Fatalf("the error stays visible: %+v", o)
	}
	if msg := r.StartBlocked("a"); !strings.Contains(msg, "crash loop") {
		t.Fatalf("StartBlocked = %q", msg)
	}
	// Starting by hand lifts the latch.
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if state(t, r, "a") != "running" {
		t.Fatal("Power start starts it")
	}
	if l, _ := st.CrashLatch("a"); l != nil {
		t.Fatal("the latch disappears")
	}
	if msg := r.StartBlocked("a"); msg != "" {
		t.Fatalf("StartBlocked = %q", msg)
	}
}

func TestCrashLatchIgnoredForNewSpecVersion(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	// A new configuration (e.g. more memory) is tried: the latch was for version 1.
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: running, SpecJson: []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))}); err != nil {
		t.Fatal(err)
	}
	if state(t, r, "a") != "running" {
		t.Fatal("with a new version it starts")
	}
	if l, _ := st.CrashLatch("a"); l != nil {
		t.Fatal("the latch from another version is deleted")
	}
}

func TestCrashLoopStopBusyWhenHeld(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	release, err := r.Hold("a", "backup")
	if err != nil {
		t.Fatal(err)
	}
	defer release(ctx)
	if err := r.CrashLoopStop(ctx, "a", 4); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
	if msg := r.StartBlocked("a"); !strings.Contains(msg, "backup") {
		t.Fatalf("StartBlocked with a reservation = %q", msg)
	}
	if msg := r.StartBlocked("unknown"); msg == "" {
		t.Fatal("a server the agent does not know is not started")
	}
}

type sinkRec struct {
	mu    sync.Mutex
	kinds []string
}

func (s *sinkRec) fn(_, kind, _ string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.kinds = append(s.kinds, kind)
}

func (s *sinkRec) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.kinds...)
}

func TestDriftEventOnlyForTheAppliedVersion(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	sink := &sinkRec{}
	r.SetEventSink(sink.fn)
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	// A new version recreates without drift.
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: running, SpecJson: []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))}); err != nil {
		t.Fatal(err)
	}
	if got := sink.list(); len(got) != 0 {
		t.Fatalf("events = %v", got)
	}
	// Someone changes the container outside the agent: same applied version, different hash.
	for _, c := range fake.Containers {
		c.Config.Labels[spec.LabelHash] = "changed-by-hand"
	}
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got := sink.list(); len(got) != 1 || got[0] != KindDrift {
		t.Fatalf("events = %v", got)
	}
}

func TestCrashLoopMessage(t *testing.T) {
	if msg := CrashLoopMessage(5); !strings.Contains(msg, "5 times") || !strings.Contains(msg, "Start") {
		t.Fatalf("msg = %q", msg)
	}
}

// A latched on-demand server that is running again (the restart policy in the window between the
// latch and the stop, or restartPolicy always after the daemon restarts) is stopped on the tick: mc-router would not
// start it (the proxy's policy prevents it), but Docker would.
func TestOnDemandLatchedServerIsStoppedByTheTick(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() })
	put(t, st, "a", "alpha", 1, running, routedJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	c, err := r.Container(ctx, "a")
	if err != nil || c == nil || c.State != "exited" {
		t.Fatalf("after the latch: %+v %v", c, err)
	}
	if err := fake.Start(ctx, c.ID); err != nil { // Docker starts it again on its own
		t.Fatal(err)
	}
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got := state(t, r, "a"); got != "exited" {
		t.Fatalf("a latched running on-demand server is stopped; state = %s", got)
	}
}

func TestCrashLoopStopUnlessStartedYieldsToPower(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	gen := r.StartGen("a")
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART); err != nil {
		t.Fatal(err)
	}
	if stopped, err := r.CrashLoopStopUnlessStarted(ctx, "a", 4, gen); err != nil || stopped {
		t.Fatalf("decided before the restart: stopped=%v err=%v", stopped, err)
	}
	if l, _ := st.CrashLatch("a"); l != nil || state(t, r, "a") != "running" {
		t.Fatal("it neither latches nor stops")
	}
	if stopped, err := r.CrashLoopStopUnlessStarted(ctx, "a", 4, r.StartGen("a")); err != nil || !stopped {
		t.Fatalf("decided after: stopped=%v err=%v", stopped, err)
	}
	if l, _ := st.CrashLatch("a"); l == nil || state(t, r, "a") != "exited" {
		t.Fatal("it latches and stops")
	}
}

// OOS2: a new spec version (Apply or the one from SyncSpecs) counts as a new start; the same version does not.
func TestStartGenBumpsOnNewSpecVersions(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, running, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	g0 := r.StartGen("a")
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: running, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: running, SpecJson: []byte(specJSON)}); err != nil {
		t.Fatal(err)
	}
	if r.StartGen("a") != g0 {
		t.Fatal("the same version does not change the generation")
	}
	v2 := []byte(strings.Replace(specJSON, `"2G"`, `"3G"`, 1))
	if err := r.Apply(ctx, &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 2, DesiredState: running, SpecJson: v2}); err != nil {
		t.Fatal(err)
	}
	g1 := r.StartGen("a")
	if g1 == g0 {
		t.Fatal("Apply of a new version changes the generation")
	}
	if err := r.StoreForce(&mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 3, DesiredState: running, SpecJson: v2}); err != nil {
		t.Fatal(err)
	}
	if r.StartGen("a") == g1 {
		t.Fatal("StoreForce of a new version changes the generation")
	}
}
