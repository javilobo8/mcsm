package docker

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/moby/moby/api/types/container"
)

// Real (trimmed) response from GET /containers/{id}/stats?stream=false&one-shot=true on cgroup v2.
const statsV2 = `{
  "read": "2026-10-12T10:00:05.123456789Z",
  "cpu_stats": {"cpu_usage": {"total_usage": 52000000000, "usage_in_kernelmode": 1, "usage_in_usermode": 2}, "system_cpu_usage": 9000000000000, "online_cpus": 8},
  "precpu_stats": {"cpu_usage": {"total_usage": 0}},
  "memory_stats": {"usage": 3221225472, "limit": 5368709120, "stats": {"inactive_file": 1073741824, "anon": 2000000000}},
  "networks": {"eth0": {"rx_bytes": 1000, "tx_bytes": 2000}, "eth1": {"rx_bytes": 10, "tx_bytes": 20}}
}`

func TestStatsFromCgroupV2(t *testing.T) {
	var r container.StatsResponse
	if err := json.Unmarshal([]byte(statsV2), &r); err != nil {
		t.Fatal(err)
	}
	s := statsFrom(&r)
	if s.CPUTotalNs != 52e9 || s.SystemCPUNs != 9e12 || s.OnlineCPUs != 8 {
		t.Fatalf("cpu = %+v", s)
	}
	if s.MemBytes != 2<<30 || s.MemLimit != 5<<30 {
		t.Fatalf("mem = %d / %d", s.MemBytes, s.MemLimit)
	}
	if s.NetRxBytes != 1010 || s.NetTxBytes != 2020 {
		t.Fatalf("net = %d / %d", s.NetRxBytes, s.NetTxBytes)
	}
	if s.Read.IsZero() {
		t.Fatal("empty read")
	}
}

func TestStatsFromCgroupV1AndFallbacks(t *testing.T) {
	r := container.StatsResponse{}
	r.CPUStats.CPUUsage.PercpuUsage = []uint64{1, 2, 3, 4}
	r.MemoryStats = container.MemoryStats{Usage: 1000, Stats: map[string]uint64{"total_inactive_file": 300, "inactive_file": 100}}
	s := statsFrom(&r)
	if s.OnlineCPUs != 4 {
		t.Fatalf("online cpus = %d, want 4 (len percpu)", s.OnlineCPUs)
	}
	if s.MemBytes != 700 {
		t.Fatalf("v1: mem = %d, want 700", s.MemBytes)
	}
	// cache greater than usage (inconsistent reading): the usage is returned as is
	r.MemoryStats = container.MemoryStats{Usage: 100, Stats: map[string]uint64{"inactive_file": 500}}
	if got := statsFrom(&r).MemBytes; got != 100 {
		t.Fatalf("mem = %d, want 100", got)
	}
}

func TestFakeStats(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	if _, err := f.Stats(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	id, err := f.Create(ctx, "mcsm-a", &container.Config{Labels: map[string]string{"mcsm.managed": "true"}}, &container.HostConfig{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s, err := f.Stats(ctx, id); err != nil || s != (Stats{}) {
		t.Fatalf("without SetStats: %+v %v", s, err)
	}
	f.SetStats(id, Stats{CPUTotalNs: 5, MemBytes: 7})
	if s, _ := f.Stats(ctx, id); s.CPUTotalNs != 5 || s.MemBytes != 7 {
		t.Fatalf("stats = %+v", s)
	}
	f.StatsErr = errors.New("daemon busy")
	if _, err := f.Stats(ctx, id); err == nil {
		t.Fatal("StatsErr must be returned")
	}
	f.StatsErr = nil
	_ = f.Remove(ctx, id)
	if _, err := f.Stats(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Remove: %v", err)
	}
}
