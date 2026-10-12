//go:build integration

package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// TestMobyPortsMissingAfterFailedStart reproduce el fallo de Docker 29.7.2 (plan-8): tras un start
// fallido por el puerto del host, el siguiente arranca sin publicar los puertos. Inspect lo detecta
// (PortsMissing). Solo contenedores mcsm-test-ports-…, que se borran.
func TestMobyPortsMissingAfterFailedStart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
	l.Close()
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	tag := hex.EncodeToString(suffix)
	host := &container.HostConfig{PortBindings: network.PortMap{network.MustParsePort("80/tcp"): {{HostPort: port}}}}
	mk := func(name string) string {
		id, err := m.Create(ctx, "mcsm-test-ports-"+name+"-"+tag,
			&container.Config{Image: "alpine:3.22", Cmd: []string{"sleep", "300"}, Labels: map[string]string{"mcsm.test": "true"}}, host, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = m.Remove(context.Background(), id) })
		return id
	}
	blocker, victim := mk("blk"), mk("vic")
	if err := m.Start(ctx, blocker); err != nil {
		t.Fatal(err)
	}
	if ins, err := m.Inspect(ctx, blocker); err != nil || !ins.Running || ins.PortsMissing {
		t.Fatalf("el primero publica su puerto: %+v %v", ins, err)
	}
	if err := m.Start(ctx, victim); err == nil {
		t.Fatal("el puerto está ocupado: el arranque debe fallar")
	}
	if err := m.Remove(ctx, blocker); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(ctx, victim); err != nil {
		t.Fatal(err)
	}
	ins, err := m.Inspect(ctx, victim)
	if err != nil || !ins.Running {
		t.Fatalf("inspect = %+v %v", ins, err)
	}
	if !ins.PortsMissing {
		t.Skip("este Docker publica los puertos tras un arranque fallido (sin el fallo de 29.7.2)")
	}
}
