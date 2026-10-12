package docker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

func TestFakeLifecycle(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	if err := f.EnsureImage(ctx, "itzg/minecraft-server:java21"); err != nil {
		t.Fatal(err)
	}
	if f.Pulled[0] != "itzg/minecraft-server:java21" {
		t.Fatalf("pulled = %v", f.Pulled)
	}
	id, err := f.Create(ctx, "mcsm-a", &container.Config{Image: "x", Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "a"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := f.ListManaged(ctx)
	if len(list) != 1 || list[0].ID != id || list[0].State != "created" || list[0].Name != "mcsm-a" {
		t.Fatalf("list = %+v", list)
	}
	if err := f.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	ins, _ := f.Inspect(ctx, id)
	if !ins.Running || ins.State != "running" {
		t.Fatalf("inspect = %+v", ins)
	}
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	ins, _ = f.Inspect(ctx, id)
	if ins.Running || ins.State != "exited" {
		t.Fatalf("inspect tras stop = %+v", ins)
	}
	if err := f.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Inspect(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if f.Calls[len(f.Calls)-1] != "Remove "+id {
		t.Fatalf("calls = %v", f.Calls)
	}
}

func TestFakeCreateErrorAndNameConflict(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	f.CreateErr = errors.New("fallo de creación inyectado")
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("esperaba error")
	}
	f.CreateErr = nil
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("nombre duplicado debe fallar")
	}
}

func TestFakeLogsAndEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := NewFake()
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.server_id": "a"}}, &container.HostConfig{}, nil)
	rc, err := f.Logs(ctx, id, 10)
	if err != nil {
		t.Fatal(err)
	}
	go f.WriteLog(id, "2026-10-12T00:00:00.000000000Z [Server] Done\n")
	buf := make([]byte, 128)
	n, _ := rc.Read(buf)
	if string(buf[:n]) != "2026-10-12T00:00:00.000000000Z [Server] Done\n" {
		t.Fatalf("log = %q", buf[:n])
	}
	rc.Close()
	if _, err := rc.Read(buf); err == nil {
		t.Fatal("tras Close, Read debe devolver error o EOF")
	}
	evs, _ := f.Events(ctx)
	go f.EmitEvent(Event{Action: "die", ContainerID: id, Labels: map[string]string{"mcsm.server_id": "a"}})
	select {
	case ev := <-evs:
		if ev.Action != "die" || ev.ContainerID != id {
			t.Fatalf("ev = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("sin evento")
	}
}

func portHost(port string) *container.HostConfig {
	return &container.HostConfig{PortBindings: network.PortMap{
		network.MustParsePort("25565/tcp"): {{HostPort: port}},
	}}
}

func TestFakeStartPortCollision(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	a, _ := f.Create(ctx, "mcsm-a", &container.Config{}, portHost("25565"), nil)
	b, _ := f.Create(ctx, "mcsm-b", &container.Config{}, portHost("25565"), nil)
	if err := f.Start(ctx, a); err != nil {
		t.Fatal(err)
	}
	err := f.Start(ctx, b)
	if err == nil || !strings.Contains(err.Error(), "port is already allocated") {
		t.Fatalf("err = %v", err)
	}
	if ins, _ := f.Inspect(ctx, b); ins.State != "created" {
		t.Fatalf("b debe seguir created, es %q", ins.State)
	}
	_ = f.Stop(ctx, a, time.Second)
	if err := f.Start(ctx, b); err != nil {
		t.Fatalf("con a parado debe arrancar: %v", err)
	}
	// Docker 29.7.2: un start tras otro fallido por el puerto arranca SIN publicar los puertos,
	// y así se queda aunque se pare y se vuelva a arrancar.
	if ins, _ := f.Inspect(ctx, b); !ins.Running || !ins.PortsMissing {
		t.Fatalf("b arranca sin puertos: %+v", ins)
	}
	_ = f.Stop(ctx, b, time.Second)
	_ = f.Start(ctx, b)
	if ins, _ := f.Inspect(ctx, b); !ins.PortsMissing {
		t.Fatal("parar y arrancar no lo arregla")
	}
	// Sin publicar no ocupa el puerto: otro contenedor puede publicarlo.
	c, _ := f.Create(ctx, "mcsm-c", &container.Config{}, portHost("25565"), nil)
	if err := f.Start(ctx, c); err != nil {
		t.Fatalf("el puerto está libre: %v", err)
	}
	if ins, _ := f.Inspect(ctx, c); ins.PortsMissing {
		t.Fatal("un contenedor sin arranques fallidos publica sus puertos")
	}
	if ins, _ := f.Inspect(ctx, a); ins.PortsMissing {
		t.Fatal("parado no cuenta como sin puertos")
	}
}

func TestPortsMissing(t *testing.T) {
	p := network.MustParsePort("25565/tcp")
	q := network.MustParsePort("8100/udp")
	want := network.PortMap{p: {{HostPort: "25565"}}, q: {{HostPort: "8100"}}}
	cases := []struct {
		name      string
		want, got network.PortMap
		missing   bool
	}{
		{"sin puertos pedidos", nil, nil, false},
		{"todos publicados", want, network.PortMap{p: {{HostPort: "25565"}}, q: {{HostPort: "8100"}}}, false},
		{"ninguno (fallo de Docker)", want, network.PortMap{}, true},
		{"expuesto sin binding", want, network.PortMap{p: nil, q: {{HostPort: "8100"}}}, true},
		{"binding sin puerto de host no cuenta", network.PortMap{p: {{}}}, network.PortMap{}, false},
	}
	for _, c := range cases {
		if got := PortsMissing(c.want, c.got); got != c.missing {
			t.Errorf("%s: PortsMissing = %v", c.name, got)
		}
	}
}

func TestFakeStartErr(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil)
	f.StartErr = errors.New("boom")
	if err := f.Start(ctx, id); err == nil {
		t.Fatal("esperaba error")
	}
}

func TestFakeStateTransitionsLikeDocker(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil)

	// Stop sobre created sigue created.
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	if ins, _ := f.Inspect(ctx, id); ins.State != "created" {
		t.Fatalf("stop sobre created -> %q", ins.State)
	}
	// Kill sobre no-running: conflicto.
	if err := f.Kill(ctx, id); !cerrdefs.IsConflict(err) {
		t.Fatalf("kill sobre created err = %v", err)
	}
	// Start sobre running es no-op.
	_ = f.Start(ctx, id)
	f.SetHealth(id, "healthy")
	before, _ := f.Inspect(ctx, id)
	time.Sleep(2 * time.Millisecond)
	if err := f.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	after, _ := f.Inspect(ctx, id)
	if !after.StartedAt.Equal(before.StartedAt) || after.Health != "healthy" {
		t.Fatalf("start sobre running modificó estado: %+v -> %+v", before, after)
	}
	// Kill -> 137; Stop sobre exited conserva ExitCode; Kill sobre exited: conflicto.
	if err := f.Kill(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	if ins, _ := f.Inspect(ctx, id); ins.State != "exited" || ins.ExitCode != 137 {
		t.Fatalf("tras kill+stop = %+v", ins)
	}
	if err := f.Kill(ctx, id); !cerrdefs.IsConflict(err) {
		t.Fatalf("kill sobre exited err = %v", err)
	}
}

func TestFakeNotFound(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	for name, err := range map[string]error{
		"start": f.Start(ctx, "x"), "stop": f.Stop(ctx, "x", time.Second),
		"kill": f.Kill(ctx, "x"), "remove": f.Remove(ctx, "x"),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s err = %v", name, err)
		}
	}
	if _, err := f.Logs(ctx, "x", 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("logs err = %v", err)
	}
}

func TestFakeListManagedFiltersAndCopiesLabels(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	_, _ = f.Create(ctx, "ajeno", &container.Config{Labels: map[string]string{"x": "y"}}, &container.HostConfig{}, nil)
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	list, _ := f.ListManaged(ctx)
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("list = %+v", list)
	}
	list[0].Labels["mcsm.managed"] = "mutado"
	ins, _ := f.Inspect(ctx, id)
	ins.Labels["otro"] = "x"
	ins2, _ := f.Inspect(ctx, id)
	if ins2.Labels["mcsm.managed"] != "true" || ins2.Labels["otro"] != "" {
		t.Fatalf("aliasing de labels: %+v", ins2.Labels)
	}
}

func TestFakeEventsCloseOnCancelAndInjectedError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := NewFake()
	evs, errs := f.Events(ctx)
	f.EmitEventErr(errors.New("conexión perdida"))
	select {
	case err := <-errs:
		if err == nil || err.Error() != "conexión perdida" {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("sin error")
	}
	cancel()
	select {
	case _, ok := <-evs:
		if ok {
			t.Fatal("evento inesperado")
		}
	case <-time.After(time.Second):
		t.Fatal("el canal debe cerrarse al cancelar ctx")
	}
}

func TestFakeEmitEventNeverBlocks(t *testing.T) {
	f := NewFake()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.EmitEvent(Event{Action: "die"}) // sin suscriptores
		ctx, cancel := context.WithCancel(context.Background())
		_, _ = f.Events(ctx)
		for i := 0; i < 1000; i++ { // buffer lleno: descarta
			f.EmitEvent(Event{Action: "die"})
		}
		cancel()
		f.EmitEvent(Event{Action: "die"}) // ctx cancelado
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("EmitEvent se bloqueó")
	}
}

func TestFakeSubscribed(t *testing.T) {
	f := NewFake()
	sub := f.Subscribed()
	select {
	case <-sub:
		t.Fatal("sin suscriptores no está cerrado")
	default:
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.Events(ctx)
	select {
	case <-sub:
	default:
		t.Fatal("con un suscriptor se cierra")
	}
	f.Events(ctx) // un segundo suscriptor no lo vuelve a cerrar (no hay pánico)
	<-f.Subscribed()
}
