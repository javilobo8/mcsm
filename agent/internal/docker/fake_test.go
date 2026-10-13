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
		t.Fatalf("inspect after stop = %+v", ins)
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
	f.CreateErr = errors.New("injected create failure")
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("expected an error")
	}
	f.CreateErr = nil
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil); err == nil {
		t.Fatal("a duplicate name must fail")
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
		t.Fatal("after Close, Read must return an error or EOF")
	}
	evs, _ := f.Events(ctx)
	go f.EmitEvent(Event{Action: "die", ContainerID: id, Labels: map[string]string{"mcsm.server_id": "a"}})
	select {
	case ev := <-evs:
		if ev.Action != "die" || ev.ContainerID != id {
			t.Fatalf("ev = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no event")
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
		t.Fatalf("b must stay created, it is %q", ins.State)
	}
	_ = f.Stop(ctx, a, time.Second)
	if err := f.Start(ctx, b); err != nil {
		t.Fatalf("with a stopped it must start: %v", err)
	}
	// Docker 29.7.2: a start after another one that failed on the port starts WITHOUT publishing the ports,
	// and stays that way even if it is stopped and started again.
	if ins, _ := f.Inspect(ctx, b); !ins.Running || !ins.PortsMissing {
		t.Fatalf("b starts without ports: %+v", ins)
	}
	_ = f.Stop(ctx, b, time.Second)
	_ = f.Start(ctx, b)
	if ins, _ := f.Inspect(ctx, b); !ins.PortsMissing {
		t.Fatal("stopping and starting does not fix it")
	}
	// Without publishing it does not occupy the port: another container can publish it.
	c, _ := f.Create(ctx, "mcsm-c", &container.Config{}, portHost("25565"), nil)
	if err := f.Start(ctx, c); err != nil {
		t.Fatalf("the port is free: %v", err)
	}
	if ins, _ := f.Inspect(ctx, c); ins.PortsMissing {
		t.Fatal("a container without failed starts publishes its ports")
	}
	if ins, _ := f.Inspect(ctx, a); ins.PortsMissing {
		t.Fatal("stopped does not count as without ports")
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
		{"no ports requested", nil, nil, false},
		{"all published", want, network.PortMap{p: {{HostPort: "25565"}}, q: {{HostPort: "8100"}}}, false},
		{"none (Docker failure)", want, network.PortMap{}, true},
		{"exposed without binding", want, network.PortMap{p: nil, q: {{HostPort: "8100"}}}, true},
		{"binding without host port does not count", network.PortMap{p: {{}}}, network.PortMap{}, false},
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
		t.Fatal("expected an error")
	}
}

func TestFakeStateTransitionsLikeDocker(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{}, &container.HostConfig{}, nil)

	// Stop on created stays created.
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	if ins, _ := f.Inspect(ctx, id); ins.State != "created" {
		t.Fatalf("stop on created -> %q", ins.State)
	}
	// Kill on non-running: conflict.
	if err := f.Kill(ctx, id); !cerrdefs.IsConflict(err) {
		t.Fatalf("kill on created err = %v", err)
	}
	// Start on running is a no-op.
	_ = f.Start(ctx, id)
	f.SetHealth(id, "healthy")
	before, _ := f.Inspect(ctx, id)
	time.Sleep(2 * time.Millisecond)
	if err := f.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	after, _ := f.Inspect(ctx, id)
	if !after.StartedAt.Equal(before.StartedAt) || after.Health != "healthy" {
		t.Fatalf("start on running modified state: %+v -> %+v", before, after)
	}
	// Kill -> 137; Stop on exited keeps ExitCode; Kill on exited: conflict.
	if err := f.Kill(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := f.Stop(ctx, id, time.Second); err != nil {
		t.Fatal(err)
	}
	if ins, _ := f.Inspect(ctx, id); ins.State != "exited" || ins.ExitCode != 137 {
		t.Fatalf("after kill+stop = %+v", ins)
	}
	if err := f.Kill(ctx, id); !cerrdefs.IsConflict(err) {
		t.Fatalf("kill on exited err = %v", err)
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
	_, _ = f.Create(ctx, "foreign", &container.Config{Labels: map[string]string{"x": "y"}}, &container.HostConfig{}, nil)
	id, _ := f.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	list, _ := f.ListManaged(ctx)
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("list = %+v", list)
	}
	list[0].Labels["mcsm.managed"] = "mutated"
	ins, _ := f.Inspect(ctx, id)
	ins.Labels["other"] = "x"
	ins2, _ := f.Inspect(ctx, id)
	if ins2.Labels["mcsm.managed"] != "true" || ins2.Labels["other"] != "" {
		t.Fatalf("labels aliasing: %+v", ins2.Labels)
	}
}

func TestFakeEventsCloseOnCancelAndInjectedError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := NewFake()
	evs, errs := f.Events(ctx)
	f.EmitEventErr(errors.New("connection lost"))
	select {
	case err := <-errs:
		if err == nil || err.Error() != "connection lost" {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("no error")
	}
	cancel()
	select {
	case _, ok := <-evs:
		if ok {
			t.Fatal("unexpected event")
		}
	case <-time.After(time.Second):
		t.Fatal("the channel must close when ctx is cancelled")
	}
}

func TestFakeEmitEventNeverBlocks(t *testing.T) {
	f := NewFake()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.EmitEvent(Event{Action: "die"}) // no subscribers
		ctx, cancel := context.WithCancel(context.Background())
		_, _ = f.Events(ctx)
		for i := 0; i < 1000; i++ { // buffer full: drops
			f.EmitEvent(Event{Action: "die"})
		}
		cancel()
		f.EmitEvent(Event{Action: "die"}) // ctx cancelled
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("EmitEvent blocked")
	}
}

func TestFakeSubscribed(t *testing.T) {
	f := NewFake()
	sub := f.Subscribed()
	select {
	case <-sub:
		t.Fatal("without subscribers it is not closed")
	default:
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.Events(ctx)
	select {
	case <-sub:
	default:
		t.Fatal("with a subscriber it closes")
	}
	f.Events(ctx) // a second subscriber does not close it again (no panic)
	<-f.Subscribed()
}
