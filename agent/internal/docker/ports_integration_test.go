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

// TestMobyPortsMissingAfterFailedStart reproduces Docker 29.7.2's failure (plan-8): after a start
// that failed on the host port, the next one starts without publishing the ports. Inspect detects it
// (PortsMissing). Only mcsm-test-ports-… containers, which are deleted.
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
		t.Fatalf("the first one publishes its port: %+v %v", ins, err)
	}
	if err := m.Start(ctx, victim); err == nil {
		t.Fatal("the port is taken: the start must fail")
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
		t.Skip("this Docker publishes the ports after a failed start (without the 29.7.2 failure)")
	}
}
