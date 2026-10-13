package reconcile

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/spec"
)

const routedJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","router":{"enabled":true,"hostname":"survival.lan"}}`

func TestOnDemandLeavesExistingContainersAlone(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	autoscale := true
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() && autoscale })

	// Freshly created: it follows the desired state (running).
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, routedJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	c, _ := r.find(ctx, "a")
	if c == nil || c.State != "running" {
		t.Fatalf("freshly created: %+v", c)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d", v)
	}

	// mc-router stops it after N minutes without players: the tick does not start it again.
	_ = fake.Stop(ctx, c.ID, time.Second)
	starts := calls(fake, "Start")
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Start") != starts {
		t.Fatal("a sleeping on-demand server is not started on the tick")
	}

	// Desired stopped and mc-router wakes it: the tick does not stop it.
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, routedJSON)
	_ = fake.Start(ctx, c.ID)
	stops := calls(fake, "Stop")
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("an awake on-demand server is not stopped on the tick")
	}

	// A spec change does recreate, and the new one is started even if the desired state is stopped: mc-router does
	// not see a container that never started (it could not wake it); it puts it to sleep without players.
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, strings.Replace(routedJSON, "survival.lan", "other.lan", 1))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	c2, _ := r.find(ctx, "a")
	if c2 == nil || c2.ID == c.ID || c2.State != "running" {
		t.Fatalf("recreated: %+v", c2)
	}
	_ = fake.Stop(ctx, c2.ID, time.Second) // mc-router puts it to sleep

	// Power still rules: it starts even if it is on-demand.
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if c3, _ := r.find(ctx, "a"); c3.State != "running" {
		t.Fatalf("after Power start: %+v", c3)
	}

	// Without autoscale the desired state is imposed again (running after the Power).
	autoscale = false
	c3, _ := r.find(ctx, "a")
	_ = fake.Stop(ctx, c3.ID, time.Second)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if c4, _ := r.find(ctx, "a"); c4.State != "running" {
		t.Fatalf("without autoscale: %+v", c4)
	}
}

func TestOnDemandOnlyForRoutedServers(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() })
	put(t, st, "b", "beta", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	c, _ := r.find(ctx, "b")
	_ = fake.Stop(ctx, c.ID, time.Second)
	if err := r.Reconcile(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	if c2, _ := r.find(ctx, "b"); c2.State != "running" {
		t.Fatal("a server without a router follows its desired state")
	}
}

// plan-8 (H1): the reservation (Hold) only holds back the agent; mc-router starts on its own a
// stopped container with a hostname. Park deletes it for as long as the reservation lasts: an attempt to join
// (docker start of the container) finds nothing to start. The release recreates and
// starts it (mc-router does not see a container that never started; it puts it back to sleep without players).
func TestParkRemovesOnDemandContainerWhileHeld(t *testing.T) {
	for _, wasRunning := range []bool{true, false} {
		r, st, fake, _, _ := setup(t)
		ctx := context.Background()
		r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() })
		put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, routedJSON)
		if err := r.Reconcile(ctx, "a"); err != nil {
			t.Fatal(err)
		}
		old, _ := r.find(ctx, "a")
		if !wasRunning {
			_ = fake.Stop(ctx, old.ID, time.Second) // asleep from inactivity
		}
		if _, err := r.Park(ctx, "a"); err == nil {
			t.Fatal("parking without a reservation is not valid: a tick would recreate it immediately")
		}
		release, err := r.Hold("a", "restore")
		if err != nil {
			t.Fatal(err)
		}
		parked, err := r.Park(ctx, "a")
		if err != nil || !parked {
			t.Fatalf("park = %v %v", parked, err)
		}
		if c, _ := r.find(ctx, "a"); c != nil {
			t.Fatalf("without a container during the reservation: %+v", c)
		}
		if err := fake.Start(ctx, old.ID); !errors.Is(err, docker.ErrNotFound) { // mc-router: a player tries to join
			t.Fatalf("mc-router start = %v", err)
		}
		release(ctx)
		if c, _ := r.find(ctx, "a"); c == nil || c.ID == old.ID || c.State != "running" {
			t.Fatalf("running=%v: after release %+v", wasRunning, c)
		}
	}
}

func TestParkLeavesOtherServersAlone(t *testing.T) {
	r, st, _, _, _ := setup(t)
	ctx := context.Background()
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() })
	put(t, st, "b", "beta", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	_ = r.Reconcile(ctx, "b")
	release, _ := r.Hold("b", "backup")
	defer release(ctx)
	if parked, err := r.Park(ctx, "b"); err != nil || parked {
		t.Fatalf("park = %v %v", parked, err)
	}
	if c, _ := r.find(ctx, "b"); c == nil || c.State != "running" {
		t.Fatal("a server without a router is not parked")
	}
}
