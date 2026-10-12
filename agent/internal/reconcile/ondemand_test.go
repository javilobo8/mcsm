package reconcile

import (
	"context"
	"strings"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/spec"
)

const routedJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25565},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","router":{"enabled":true,"hostname":"survival.lan"}}`

func TestOnDemandLeavesExistingContainersAlone(t *testing.T) {
	r, st, fake, _, _ := setup(t)
	ctx := context.Background()
	autoscale := true
	r.SetOnDemand(func(s spec.Spec) bool { return s.Router.Active() && autoscale })

	// Recién creado: sigue el estado deseado (running).
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_RUNNING, routedJSON)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	c, _ := r.find(ctx, "a")
	if c == nil || c.State != "running" {
		t.Fatalf("recién creado: %+v", c)
	}
	if v, _ := st.Applied("a"); v != 1 {
		t.Fatalf("applied = %d", v)
	}

	// mc-router lo para tras N minutos sin jugadores: el tick no lo vuelve a arrancar.
	_ = fake.Stop(ctx, c.ID, time.Second)
	starts := calls(fake, "Start")
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Start") != starts {
		t.Fatal("un servidor bajo demanda dormido no se arranca en el tick")
	}

	// Deseado parado y mc-router lo despierta: el tick no lo para.
	put(t, st, "a", "alpha", 1, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, routedJSON)
	_ = fake.Start(ctx, c.ID)
	stops := calls(fake, "Stop")
	if err := r.ReconcileTick(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if calls(fake, "Stop") != stops {
		t.Fatal("un servidor bajo demanda despierto no se para en el tick")
	}

	// Un cambio de spec sí recrea (y el nuevo sigue el estado deseado: parado).
	put(t, st, "a", "alpha", 2, mcsmv1.DesiredState_DESIRED_STATE_STOPPED, strings.Replace(routedJSON, "survival.lan", "otro.lan", 1))
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	c2, _ := r.find(ctx, "a")
	if c2 == nil || c2.ID == c.ID || c2.State != "created" {
		t.Fatalf("recreado: %+v", c2)
	}

	// Power sigue mandando: arranca aunque esté bajo demanda.
	if err := r.Power(ctx, "a", mcsmv1.PowerActionType_POWER_ACTION_TYPE_START); err != nil {
		t.Fatal(err)
	}
	if c3, _ := r.find(ctx, "a"); c3.State != "running" {
		t.Fatalf("tras Power start: %+v", c3)
	}

	// Sin autoscale vuelve a imponerse el estado deseado (running tras el Power).
	autoscale = false
	c3, _ := r.find(ctx, "a")
	_ = fake.Stop(ctx, c3.ID, time.Second)
	if err := r.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if c4, _ := r.find(ctx, "a"); c4.State != "running" {
		t.Fatalf("sin autoscale: %+v", c4)
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
		t.Fatal("un servidor sin router sigue su estado deseado")
	}
}
