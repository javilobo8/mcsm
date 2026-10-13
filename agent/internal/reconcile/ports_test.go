package reconcile

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
)

// blockPort starts in the fake a foreign container that publishes port (another process on the port).
func blockPort(t *testing.T, fake *docker.Fake, port string) string {
	t.Helper()
	ctx := context.Background()
	id, err := fake.Create(ctx, "foreign-"+port, &container.Config{Image: "x"},
		&container.HostConfig{PortBindings: network.PortMap{network.MustParsePort(port + "/tcp"): {{HostPort: port}}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func serverContainer(t *testing.T, r *Reconciler, id string) *docker.Container {
	t.Helper()
	c, err := r.Container(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Docker 29.7.2: after a start that failed on the port, the next one starts without publishing it. The
// reconciler discards the container on failure and recreates it on the next pass (backoff).
func TestStartFailureDiscardsContainer(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	blocker := blockPort(t, fake, "25565")
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, specJSON)
	if err := r.Reconcile(ctx, "a"); err == nil {
		t.Fatal("the port is taken")
	}
	if c := serverContainer(t, r, "a"); c != nil {
		t.Fatalf("the container that could not start is discarded: %+v", c)
	}
	if obs := rec.get("a"); obs.State != "missing" || !strings.Contains(obs.Error, "already allocated") || !strings.Contains(obs.Error, "will be recreated") {
		t.Fatalf("obs = %+v", obs)
	}
	_ = fake.Stop(ctx, blocker, time.Second)
	r.now = func() time.Time { return time.Unix(1_000_000+31, 0) }
	r.ReconcileAll(ctx)
	c := serverContainer(t, r, "a")
	ins, _ := fake.Inspect(ctx, c.ID)
	if !ins.Running || ins.PortsMissing || rec.get("a").Error != "" {
		t.Fatalf("recreated: %+v obs=%+v", ins, rec.get("a"))
	}
}

// A container that another party (the restart policy, mc-router) tried to start with the port
// taken is left tainted: "Start" discards it and recreates it, and it starts publishing the port.
func TestPowerStartRecreatesContainerLeftWithoutPorts(t *testing.T) {
	r, st, fake, rec, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	old := serverContainer(t, r, "a")
	blocker := blockPort(t, fake, "25565")
	if err := fake.Start(ctx, old.ID); err == nil { // foreign start with the port taken
		t.Fatal("the port is taken")
	}
	_ = fake.Stop(ctx, blocker, time.Second)
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	c := serverContainer(t, r, "a")
	ins, _ := fake.Inspect(ctx, c.ID)
	if c.ID == old.ID || !ins.Running || ins.PortsMissing {
		t.Fatalf("Start must recreate it with ports: old=%s %+v", old.ID, ins)
	}
	if d := desired(t, st, "a"); d != mcsmv1.DesiredState_DESIRED_STATE_RUNNING || rec.get("a").Error != "" {
		t.Fatalf("desired=%v obs=%+v", d, rec.get("a"))
	}
}

// If another party started it and it stayed running without ports, Observed says so and "Restart" fixes it.
func TestRunningWithoutPortsIsObservedAndRestartFixesIt(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, specJSON)
	_ = r.Reconcile(ctx, "a")
	old := serverContainer(t, r, "a")
	blocker := blockPort(t, fake, "25565")
	_ = fake.Start(ctx, old.ID)
	_ = fake.Stop(ctx, blocker, time.Second)
	if err := fake.Start(ctx, old.ID); err != nil { // e.g. mc-router wakes it
		t.Fatal(err)
	}
	if obs := r.Observe(ctx, "a"); obs.State != "running" || !strings.Contains(obs.Error, "without publishing its ports") {
		t.Fatalf("obs = %+v", obs)
	}
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_RESTART); err != nil {
		t.Fatal(err)
	}
	c := serverContainer(t, r, "a")
	ins, _ := fake.Inspect(ctx, c.ID)
	if c.ID == old.ID || !ins.Running || ins.PortsMissing {
		t.Fatalf("Restart must recreate it: %+v", ins)
	}
	if obs := r.Observe(ctx, "a"); obs.Error != "" {
		t.Fatalf("obs = %+v", obs)
	}
}
