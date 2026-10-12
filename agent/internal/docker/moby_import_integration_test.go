//go:build integration

package docker

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
)

func TestMobyImportInspectAndConnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	const netName, name = "mcsm-test-import-net", "mcsm-test-import"
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureNetwork(ctx, netName); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = m.cli.NetworkRemove(context.Background(), netName, client.NetworkRemoveOptions{}) }()
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	if all, err := m.ListAll(ctx); err == nil {
		for _, c := range all {
			if c.Name == name {
				_ = m.Remove(ctx, c.ID)
			}
		}
	}
	dir := t.TempDir()
	id, err := m.Create(ctx, name,
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sleep", "300"}, Env: []string{"FOO=bar"},
			Labels: map[string]string{"mcsm.test": "true", "com.docker.compose.project": "mcsm-test"}},
		&container.HostConfig{
			Binds:         []string{dir + ":/data", dir + ":/extra:ro"},
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
			PortBindings:  network.PortMap{network.MustParsePort("25565/tcp"): {{HostPort: "25596"}}},
			Resources:     container.Resources{Memory: 64 << 20, NanoCPUs: 5e8},
		}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	all, err := m.ListAll(ctx)
	if err != nil || !slices.ContainsFunc(all, func(c Container) bool { return c.ID == id && c.Labels["mcsm.test"] == "true" }) {
		t.Fatalf("ListAll no devuelve el contenedor: %v", err)
	}
	info, err := m.InspectImport(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != name || info.Image != "alpine:3.22" || !strings.HasPrefix(info.ImageID, "sha256:") || info.State != "running" ||
		!slices.Contains(info.Env, "FOO=bar") || info.Restart != "unless-stopped" || info.Memory != 64<<20 || info.NanoCPUs != 5e8 {
		t.Fatalf("inspect = %+v", info)
	}
	if len(info.Ports) != 1 || info.Ports[0] != (PortPublish{ContainerPort: 25565, Proto: "tcp", HostPort: 25596}) {
		t.Fatalf("ports = %+v", info.Ports)
	}
	if !slices.Contains(info.Mounts, Mount{Type: "bind", Source: dir, Destination: "/data", RW: true}) ||
		!slices.Contains(info.Mounts, Mount{Type: "bind", Source: dir, Destination: "/extra", RW: false}) {
		t.Fatalf("mounts = %+v", info.Mounts)
	}
	env, err := m.ImageEnv(ctx, info.ImageID)
	if err != nil || !slices.ContainsFunc(env, func(e string) bool { return strings.HasPrefix(e, "PATH=") }) {
		t.Fatalf("ImageEnv = %v, %v", env, err)
	}
	if err := m.ConnectNetwork(ctx, netName, id, []string{"mcsm-test-alias"}); err != nil {
		t.Fatal(err)
	}
	info, _ = m.InspectImport(ctx, id)
	if !slices.Contains(info.Networks, netName) {
		t.Fatalf("networks = %v", info.Networks)
	}
	if _, err := m.InspectImport(ctx, "mcsm-test-no-existe"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}
