package app

import (
	"context"
	"errors"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/errcode"
	"mcsm/agent/internal/router"
	"mcsm/agent/internal/store"
)

// newRouterApp es newApp con un router que no depende del socket de Docker de la máquina de tests.
func newRouterApp(t *testing.T) (*App, *docker.Fake, *store.Store, *sink) {
	t.Helper()
	a, fake, st := newApp(t)
	a.router = router.New(fake, st, router.Options{Network: "mcsm", SocketGID: func() (uint32, error) { return 967, nil }})
	s := newSink()
	a.send = s.send
	return a, fake, st, s
}

// waitRouter descarta mensajes hasta un RouterObserved que cumpla ok.
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
		t.Fatalf("respuesta = %v", e)
	}
	obs := waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return o.State == "running" })
	if !obs.Configured || obs.HostPort != 25565 || obs.Error != "" {
		t.Fatalf("observed = %+v", obs)
	}
	if routerOf(fake) == nil {
		t.Fatal("falta el contenedor del router")
	}
	waitBackground(t, a)

	a.Handle(ctx, &mcsmv1.Envelope{Id: 6, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	if e := s.waitID(t, 6); e.GetAck() == nil {
		t.Fatalf("respuesta = %v", e)
	}
	waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return !o.Configured && o.State == "missing" })
	if routerOf(fake) != nil {
		t.Fatal("el contenedor del router se borra")
	}
	if sp, _ := st.RouterSpec(); sp != nil {
		t.Fatal("la spec se borra")
	}
	// Idempotente.
	a.Handle(ctx, &mcsmv1.Envelope{Id: 7, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	if e := s.waitID(t, 7); e.GetAck() == nil {
		t.Fatalf("respuesta = %v", e)
	}
	waitBackground(t, a)
}

func TestRouterApplyInvalid(t *testing.T) {
	a, fake, st, s := newRouterApp(t)
	for i, req := range []*mcsmv1.RouterApply{{}, {Spec: &mcsmv1.RouterSpec{HostPort: 0}}, {Spec: &mcsmv1.RouterSpec{HostPort: 70000}}} {
		id := uint64(10 + i)
		a.Handle(context.Background(), &mcsmv1.Envelope{Id: id, Body: &mcsmv1.Envelope_RouterApply{RouterApply: req}}, s.send)
		if e := s.waitID(t, id); e.GetError().GetCode() != errcode.InvalidRequest {
			t.Fatalf("%v: respuesta = %v", req, e)
		}
	}
	waitBackground(t, a)
	if sp, _ := st.RouterSpec(); sp != nil || routerOf(fake) != nil {
		t.Fatal("una spec inválida no se guarda ni crea nada")
	}
}

func TestRouterRecreatedAfterManualDelete(t *testing.T) {
	a, fake, _, s := newRouterApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 5, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565}}}}, s.send)
	first := waitRouter(t, s, func(o *mcsmv1.RouterObserved) bool { return o.State == "running" }).ContainerId
	waitBackground(t, a)
	go a.eventLoop(ctx)
	select { // el bucle de eventos ya está suscrito: el evento no se pierde
	case <-fake.Subscribed():
	case <-time.After(3 * time.Second):
		t.Fatal("el bucle de eventos no se suscribió")
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

	// mc-router lo para por inactividad: el agente no lo vuelve a arrancar.
	c, _ := a.rec.Container(ctx, "a")
	_ = fake.Stop(ctx, c.ID, time.Second)
	if err := a.rec.Reconcile(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if c, _ := a.rec.Container(ctx, "a"); c.State != "exited" {
		t.Fatalf("bajo demanda: %s", c.State)
	}

	// Sin router, vuelve a imponerse el estado deseado (RouterRemove reconcilia todos los servidores).
	a.Handle(ctx, &mcsmv1.Envelope{Id: 3, Body: &mcsmv1.Envelope_RouterRemove{RouterRemove: &mcsmv1.RouterRemove{}}}, s.send)
	s.waitID(t, 3)
	waitBackground(t, a)
	if c, _ := a.rec.Container(ctx, "a"); c.State != "running" {
		t.Fatalf("sin autoscale: %s", c.State)
	}
}

func TestLoadConfigRouterName(t *testing.T) {
	t.Setenv("PANEL_URL", "http://p")
	t.Setenv("MCSM_ROUTER_NAME", "")
	cfg, err := LoadConfig("x")
	if err != nil || cfg.RouterName != "mcsm-router" {
		t.Fatalf("por defecto: %q %v", cfg.RouterName, err)
	}
	t.Setenv("MCSM_ROUTER_NAME", "mcsm-test-router")
	if cfg, err = LoadConfig("x"); err != nil || cfg.RouterName != "mcsm-test-router" {
		t.Fatalf("%q %v", cfg.RouterName, err)
	}
	for _, bad := range []string{"router", "mcsm-", "mcsm-Router", "mcsm-a/b", "otro-mcsm-router"} {
		t.Setenv("MCSM_ROUTER_NAME", bad)
		if _, err := LoadConfig("x"); err == nil {
			t.Fatalf("MCSM_ROUTER_NAME=%q debe fallar", bad)
		}
	}
}

// failingRouterStore: el store del agente falla al guardar la spec del router (bbolt).
type failingRouterStore struct{ *store.Store }

func (failingRouterStore) PutRouterSpec(*mcsmv1.RouterSpec) error {
	return errors.New("bbolt: disco lleno")
}

// m5: una spec inválida es invalid_request; un fallo del store, io_error.
func TestRouterApplyStoreFailureIsIOError(t *testing.T) {
	a, fake, st, s := newRouterApp(t)
	a.router = router.New(fake, failingRouterStore{st}, router.Options{Network: "mcsm", SocketGID: func() (uint32, error) { return 967, nil }})
	a.Handle(context.Background(), &mcsmv1.Envelope{Id: 9, Body: &mcsmv1.Envelope_RouterApply{RouterApply: &mcsmv1.RouterApply{Spec: &mcsmv1.RouterSpec{HostPort: 25565}}}}, s.send)
	if e := s.waitID(t, 9); e.GetError().GetCode() != errcode.IOError {
		t.Fatalf("respuesta = %v", e)
	}
	waitBackground(t, a)
}
