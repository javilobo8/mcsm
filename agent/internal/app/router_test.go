package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/dockerproxy"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/router"
	"mcsm/agent/internal/spec"
	"mcsm/agent/internal/store"
)

// newRouterApp is newApp with a router that does not depend on the test machine's Docker socket.
func newRouterApp(t *testing.T) (*App, *docker.Fake, *store.Store, *sink) {
	t.Helper()
	a, fake, st := newApp(t)
	a.router = router.New(fake, st, router.Options{Network: "mcsm", ProxySocket: "/srv/minecraft/.mcsm-router/docker.sock"})
	s := newSink()
	a.send = s.send
	return a, fake, st, s
}

// waitRouter discards messages until a RouterObserved that satisfies ok.
func waitRouter(t *testing.T, s *sink, ok func(*mcsmv1.RouterObserved) bool) *mcsmv1.RouterObserved {
	t.Helper()
	for {
		if o := s.next(t).GetRouterObserved(); o != nil && ok(o) {
			return o
		}
	}
}

func routerOf(fake *docker.Fake) *docker.Container {
	list, _ := fake.ListManaged(context.Background())
	for i := range list {
		if list[i].Labels[router.LabelRouter] == "true" {
			return &list[i]
		}
	}
	return nil
}

func TestRouterApplyAndRemove(t *testing.T) {
	a, fake, st, s := newRouterApp(t)
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565}}}}, s.send)
	if e := s.waitID(t, 5); e.GetAck() == nil {
		t.Fatalf("response = %v", e)
	}
	obs := waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return o.State == "running" })
	if !obs.Configured || obs.HostPort != 25565 || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}
	if routerOf(fake) == nil {
		t.Fatal("the router container is missing")
	}
	waitBackground(t, a)

	a.Handle(ctx, &mcsmv1.Envelope{Id: 6, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	if e := s.waitID(t, 6); e.GetAck() == nil {
		t.Fatalf("response = %v", e)
	}
	waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return !o.Configured && o.State == "missing" })
	if routerOf(fake) != nil {
		t.Fatal("the router container is deleted")
	}
	if sp, _ := st.RouterSpec(); sp != nil {
		t.Fatal("the spec is deleted")
	}
	// Idempotent.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	if e := s.waitID(t, 7); e.GetAck() == nil {
		t.Fatalf("response = %v", e)
	}
	waitBackground(t, a)
}

func TestRouterApplyInvalid(t *testing.T) {
	a, fake, st, s := newRouterApp(t)
	for i, req := range []*mcsmv1.RouterApply{{}, {Spec: &mcsmv1.RouterSpec{HostPort: 0}}, {Spec: &mcsmv1.RouterSpec{HostPort: 70000}}} {
		id := uint64(10 + i)
		a.Handle(context.Background(), &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_RouterApply{RouterApply: req}}, s.send)
		if e := s.waitID(t, id); e.GetError().GetCode() != errcode.InvalidRequest {
			t.Fatalf("%v: response = %v", req, e)
		}
	}
	waitBackground(t, a)
	if sp, _ := st.RouterSpec(); sp != nil || routerOf(fake) != nil {
		t.Fatal("an invalid spec is neither stored nor creates anything")
	}
}

func TestRouterRecreatedAfterManualDelete(t *testing.T) {
	a, fake, _, s := newRouterApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565}}}}, s.send)
	first := waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return o.State == "running" }).ContainerId
	waitBackground(t, a)
	runEventLoop(t, a)
	select { // the event loop is already subscribed: the event is not lost
	case <-fake.Subscribed():
	case <-time.After(3 * time.Second):
		t.Fatal("the event loop did not subscribe")
	}
	_ = fake.Remove(ctx, first) // docker rm -f mcsm-router
	fake.EmitEvent(docker.Event{Action: "destroy", ContainerID: first, Labels: map[string]string{"mcsm.managed": "true", router.LabelRouter: "true"}})
	waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return o.State == "running" && o.ContainerId != first })
}

const routedSpecJSON = `{"imageTag":"java21","type":"PAPER","version":"1.21.4","memory":"2G","ports":{"game":25570},"restartPolicy":"unless-stopped","rconPassword":"abcdefgh","router":{"enabled":true,"hostname":"survival.lan"}}`

func TestRouterAutoscaleMakesRoutedServersOnDemand(t *testing.T) {
	a, fake, _, s := newRouterApp(t)
	ctx := context.Background()
	sp := &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(routedSpecJSON)}
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: sp}}}, s.send)
	s.waitID(t, 1)
	a.Handle(ctx, &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565, Autoscale: true}}}}, s.send)
	s.waitID(t, 2)
	waitBackground(t, a)

	// mc-router stops it for inactivity: the agent does not start it again.
	c, _ := a.rec.Container(ctx, "a")
	_ = fake.Stop(ctx, c.ID, time.Second)
	if err := a.rec.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if c, _ := a.rec.Container(ctx, "a"); c.State != "exited" {
		t.Fatalf("on-demand: %s", c.State)
	}

	// Without a router, the desired state is imposed again (RouterRemove reconciles all the servers).
	a.Handle(ctx, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	s.waitID(t, 3)
	waitBackground(t, a)
	if c, _ := a.rec.Container(ctx, "a"); c.State != "running" {
		t.Fatalf("without autoscale: %s", c.State)
	}
}

func TestLoadConfigRouterName(t *testing.T) {
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("MCSM_ROUTER_NAME", "")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.RouterName != "mcsm-router" {
		t.Fatalf("default: %q %v", cfg.RouterName, err)
	}
	t.Setenv("MCSM_ROUTER_NAME", "mcsm-test-router")
	if cfg, err = LoadConfig("x"); err != nil || cfg.RouterName != "mcsm-test-router" {
		t.Fatalf("%q %v", cfg.RouterName, err)
	}
	for _, bad := range []string{"router", "mcsm-", "mcsm-Router", "mcsm-a/b", "other-mcsm-router"} {
		t.Setenv("MCSM_ROUTER_NAME", bad)
		if _, err := LoadConfig("x"); err == nil {
			t.Fatalf("MCSM_ROUTER_NAME=%q must fail", bad)
		}
	}
}

// failingRouterStore: the agent's store fails when saving the router's spec (bbolt).
type failingRouterStore struct{ *store.Store }

func (failingRouterStore) PutRouterSpec(*mcsmv1.RouterSpec) error {
	return errors.New("bbolt: disk full")
}

// m5: an invalid spec is invalid_request; a store failure, io_error.
func TestRouterApplyStoreFailureIsIOError(t *testing.T) {
	a, fake, st, s := newRouterApp(t)
	a.router = router.New(fake, failingRouterStore{st}, router.Options{Network: "mcsm", ProxySocket: "/srv/minecraft/.mcsm-router/docker.sock"})
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565}}}}, s.send)
	if e := s.waitID(t, 9); e.GetError().GetCode() != errcode.IOError {
		t.Fatalf("response = %v", e)
	}
	waitBackground(t, a)
}

func TestRouterPolicyOnlyRoutedUnheldServers(t *testing.T) {
	a, _, _, s := newRouterApp(t)
	routed := strings.Replace(specJSON, `"rconPassword"`, `"router":{"enabled":true,"hostname":"a.lan"},"rconPassword"`, 1)
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "a", Slug: "alpha", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(routed)}}}}, s.send)
	other := strings.Replace(specJSON, "25565", "25566", 1) // another port: the fake does not allow two on the same one
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 2, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: &mcsmv1.ServerSpec{ServerId: "b", Slug: "beta", Version: 1, DesiredState: mcsmv1.DesiredState_DESIRED_STATE_RUNNING, SpecJson: []byte(other)}}}}, s.send)
	ctx := context.Background()
	ca, cb := a.rec.ContainerID(ctx, "a"), a.rec.ContainerID(ctx, "b")
	if err := a.routerPolicy(ctx, dockerproxy.OpStart, ca); err != nil {
		t.Fatalf("with hostname: %v", err)
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStop, cb); err == nil {
		t.Fatal("without a router hostname it is not touched")
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStart, "nonexistent"); err == nil {
		t.Fatal("an unknown container is not started")
	}
	release, err := a.rec.Hold("a", "restore")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStart, ca); err == nil || !strings.Contains(err.Error(), "restore") {
		t.Fatalf("reserved: %v", err)
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStop, ca); err == nil {
		t.Fatal("reserved is not stopped either")
	}
	release(ctx)
	if err := a.routerPolicy(ctx, dockerproxy.OpStop, ca); err != nil || !a.intents.Consume(ca) {
		t.Fatalf("stop allowed and recorded: %v", err)
	}
	// Latched by a crash loop: mc-router does not wake it; stopping it is allowed.
	if err := a.rec.CrashLoopStop(ctx, "a", 4); err != nil {
		t.Fatal(err)
	}
	ca = a.rec.ContainerID(ctx, "a")
	if err := a.routerPolicy(ctx, dockerproxy.OpStart, ca); err == nil || !strings.Contains(err.Error(), "crash loop") {
		t.Fatalf("latched: %v", err)
	}
}

// The mcsm labels can be set by anyone who creates containers on the same Docker: mc-router does not stop a
// container of a server this agent does not know.
func TestRouterPolicyDoesNotStopUnknownServers(t *testing.T) {
	a, fake, _, _ := newRouterApp(t)
	ctx := context.Background()
	id, err := fake.Create(ctx, "mcsm-foreign", &container.Config{Labels: map[string]string{
		spec.LabelManaged: "true", spec.LabelServerID: "foreign", spec.LabelRouterHost: "foreign.lan"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStop, id); err == nil {
		t.Fatal("a server the agent does not know is not stopped")
	}
	if err := a.routerPolicy(ctx, dockerproxy.OpStart, id); err == nil {
		t.Fatal("nor started")
	}
}
