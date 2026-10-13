//go:build integration

package docker

import (
	"bufio"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func TestMobyLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	const netName = "mcsm-test-net"
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if v, err := m.Version(ctx); err != nil || v == "" {
		t.Fatalf("version: %q %v", v, err)
	}
	if err := m.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	// Cleanup of the test network even if the test fails (only the mcsm-test-net network).
	defer func() { _, _ = m.cli.NetworkRemove(context.Background(), netName, client.NetworkRemoveOptions{}) }()
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	name := "mcsm-test-lifecycle"
	if old, err := m.ListManaged(ctx); err == nil {
		for _, c := range old {
			if c.Name == name {
				_ = m.Remove(ctx, c.ID)
			}
		}
	}
	id, err := m.Create(ctx, name,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sh", "-c", "echo hello; sleep 300"}, Tty: true, Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "int"}},
		&container.HostConfig{},
		&network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{netName: {}}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	ins, err := m.Inspect(ctx, id)
	if err != nil || !ins.Running || ins.Name != name {
		t.Fatalf("inspect = %+v, %v", ins, err)
	}
	rc, err := m.Logs(ctx, id, 10)
	if err != nil {
		t.Fatal(err)
	}
	line, _ := bufio.NewReader(rc).ReadString('\n')
	rc.Close()
	if !strings.Contains(line, "hello") || !strings.Contains(line, "T") {
		t.Fatalf("log without timestamp or without content: %q", line)
	}
	list, _ := m.ListManaged(ctx)
	found := false
	for _, c := range list {
		found = found || c.ID == id
	}
	if !found {
		t.Fatal("ListManaged does not return the container")
	}
	if err := m.Stop(ctx, id, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	ins, err = m.Inspect(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if ins.Running {
		t.Fatal("should be stopped")
	}
	if err := m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Inspect(ctx, id); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestMobyEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	evCtx, evCancel := context.WithCancel(ctx)
	defer evCancel()
	evs, _ := m.Events(evCtx)

	id, err := m.Create(ctx, "mcsm-test-events",
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sleep", "300"}, Labels: map[string]string{"mcsm.managed": "true", "mcsm.test": "true", "mcsm.server_id": "ev"}},
		&container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(30 * time.Second)
	for got := false; !got; {
		select {
		case ev, ok := <-evs:
			if !ok {
				t.Fatal("events channel closed before receiving start")
			}
			if ev.Action == "start" && ev.ContainerID == id {
				got = true
				if ev.Labels["mcsm.server_id"] != "ev" {
					t.Fatalf("labels = %v", ev.Labels)
				}
			}
		case <-timeout:
			t.Fatal("no start event")
		}
	}
	evCancel()
	for {
		select {
		case _, ok := <-evs:
			if !ok {
				return
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the events channel was not closed after cancelling")
		}
	}
}
