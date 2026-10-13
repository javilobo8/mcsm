//go:build integration

package docker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
)

func TestMobyStats(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m, err := NewMoby()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.EnsureImage(ctx, "alpine:3.22"); err != nil {
		t.Fatal(err)
	}
	id, err := m.Create(ctx, "mcsm-test-stats",
		&container.Config{Image: "alpine:3.22", Cmd: []string{"sh", "-c", "while :; do :; done"}, Labels: map[string]string{"mcsm.managed": "true", "mcsm.test": "true", "mcsm.server_id": "stats"}},
		&container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Remove(context.Background(), id)
	if err := m.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	first, err := m.Stats(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 900*time.Millisecond {
		t.Fatalf("Stats took %s: it must be one-shot (without waiting for the previous sample)", took)
	}
	if first.SystemCPUNs == 0 || first.OnlineCPUs == 0 || first.MemBytes == 0 || first.MemLimit == 0 {
		t.Fatalf("incomplete reading: %+v", first)
	}
	// The container burns CPU: the second reading must have more accumulated CPU.
	deadline := time.Now().Add(10 * time.Second)
	for {
		second, err := m.Stats(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if second.CPUTotalNs > first.CPUTotalNs && second.SystemCPUNs > first.SystemCPUNs {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("accumulated CPU does not advance: %+v → %+v", first, second)
		}
	}
	if _, err := m.Stats(ctx, "mcsm-test-nonexistent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
