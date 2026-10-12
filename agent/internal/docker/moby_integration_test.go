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
	// Limpieza de la red de test aunque el test falle (solo la red mcsm-test-net).
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
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sh", "-c", "echo hola; sleep 300"}, Tty: true, Labels: map[string]string{"mcsm.managed": "true", "mcsm.server_id": "int"}},
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
	if !strings.Contains(line, "hola") || !strings.Contains(line, "T") {
		t.Fatalf("log sin timestamp o sin contenido: %q", line)
	}
	list, _ := m.ListManaged(ctx)
	found := false
	for _, c := range list {
		found = found || c.ID == id
	}
	if !found {
		t.Fatal("ListManaged no devuelve el contenedor")
	}
	if err := m.Stop(ctx, id, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	ins, _ = m.Inspect(ctx, id)
	if ins.Running {
		t.Fatal("debería estar parado")
	}
	if err := m.Remove(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Inspect(ctx, id); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
