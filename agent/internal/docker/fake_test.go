package docker

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
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
	f.CreateErr = errors.New("puerto ocupado")
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
	if _, err := io.ReadAll(rc); err == nil {
		// cerrado: el siguiente Read devuelve error o EOF; cualquiera vale
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
