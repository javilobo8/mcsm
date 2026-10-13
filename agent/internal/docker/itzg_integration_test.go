//go:build integration

package docker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"

	"mcsm/agent/internal/spec"
)

// runAlpine runs a command as root in alpine with dir mounted at /w and waits for it to finish.
func runAlpine(t *testing.T, m *Moby, name, dir string, cmd ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	id, err := m.Create(ctx, name, &container.Config{Image: "alpine:3.22", Cmd: cmd, Labels: map[string]string{"mcsm.test": "true"}},
		&container.HostConfig{Binds: []string{dir + ":/w"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	wait := m.cli.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case <-wait.Result:
	case err := <-wait.Error:
		t.Fatal(err)
	}
}

// BuildContainer's hardened HostConfig (CapDrop ALL + minimal CapAdd,
// no-new-privileges, pids and memory) starts itzg and reaches healthy with a data
// directory created by root, as the agent creates it. Slow: it downloads the vanilla server.
func TestItzgHardenedReachesHealthy(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	const netName = "mcsm-test-net"
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = m.cli.NetworkRemove(context.Background(), netName, client.NetworkRemoveOptions{}) }()
	if err := m.EnsureImage(ctx, spec.Image+":latest"); err != nil {
		t.Fatal(err)
	}

	root := filepath.Join(t.TempDir(), "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// Data directory owned by root (the agent runs as root); at the end it is
	// also deleted as root, because itzg leaves it owned by uid 1000.
	runAlpine(t, m, "mcsm-test-itzg-prep", root, "mkdir", "-p", "/w/test-itzg/data")
	defer runAlpine(t, m, "mcsm-test-itzg-clean", root, "rm", "-rf", "/w/test-itzg")

	s, err := spec.Parse([]byte(`{"type":"VANILLA","version":"1.21.4","memory":"1G","ports":{"game":25565},"rconPassword":"abcdefgh123"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := spec.BuildContainer(spec.Meta{ServerID: "itzg-int", Slug: "test-itzg", Version: 1}, s, root, netName)
	if err != nil {
		t.Fatal(err)
	}
	b.Config.Labels["mcsm.test"] = "true"
	b.HostConfig.PortBindings = network.PortMap{} // not published: does not clash with anything on the host
	if old, err := m.ListManaged(ctx); err == nil {
		for _, c := range old {
			if c.Name == b.Name {
				_ = m.Remove(ctx, c.ID)
			}
		}
	}
	id, err := m.Create(ctx, b.Name, b.Config, b.HostConfig, b.Networking)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		ins, err := m.Inspect(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if ins.Health == "healthy" {
			break
		}
		if !ins.Running {
			t.Fatalf("the container stopped (exit %d) before being healthy", ins.ExitCode)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("not healthy in time (state %s/%s)", ins.State, ins.Health)
		case <-tick.C:
		}
	}
	if err := m.Stop(ctx, id, time.Minute); err != nil {
		t.Fatal(err)
	}
	if ins, _ := m.Inspect(ctx, id); ins == nil || ins.ExitCode != 0 {
		t.Fatalf("clean stop expected: %+v", ins)
	}
}
