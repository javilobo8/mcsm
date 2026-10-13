package app

import (
	"context"
	"testing"
	"time"

	mcsmv1 "mcsm/agent/gen/mcsm/v1"
	"mcsm/agent/internal/docker"
	"mcsm/agent/internal/stats"
)

type hostStub struct{ calls int }

func (h *hostStub) CPUTimes(context.Context) (stats.CPUTimes, error) {
	h.calls++
	return stats.CPUTimes{Busy: float64(100 * h.calls), Total: float64(1000 * h.calls)}, nil
}
func (h *hostStub) Memory(context.Context) (uint64, uint64, error) { return 1 << 30, 8 << 30, nil }
func (h *hostStub) Disk(context.Context, string) (uint64, uint64, error) {
	return 10 << 30, 100 << 30, nil
}

type rconStub struct{ closed bool }

func (r *rconStub) Command(context.Context, string) (string, error) {
	return "§6TPS from last 1m, 5m, 15m: §a19.5, §a20.0, §a20.0", nil
}
func (r *rconStub) Close() error { r.closed = true; return nil }

func TestSamplerUsesStoreSpecs(t *testing.T) {
	a, fake, _ := newApp(t)
	s := newSink()
	a.send = s.send
	ctx := context.Background()
	a.Handle(ctx, &mcsmv1.Envelope{Id: 1, Body: &mcsmv1.Envelope_ApplySpec{ApplySpec: &mcsmv1.ApplySpec{Server: specMsg("a", "alpha", 1)}}}, s.send)
	s.waitID(t, 1)
	cid := a.rec.ContainerID(ctx, "a")
	a.status = func(_ context.Context, host string, _ uint16) *mcsmv1.McStatus {
		return &mcsmv1.McStatus{Online: host == "mcsm-alpha", PlayersOnline: 2, PlayersMax: 20, LatencyMs: 3}
	}
	var dialed string
	dial := func(_ context.Context, host string, port uint16, pw string) (stats.Rcon, error) {
		dialed = host + "|" + pw
		return &rconStub{}, nil
	}
	sm := a.newSampler(&hostStub{}, stats.RealClock, dial)
	t0 := time.Date(2026, 10, 12, 10, 0, 5, 0, time.UTC)
	fake.SetStats(cid, docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	if b := sm.Sample(ctx, t0); b != nil {
		t.Fatalf("first reading: %v", b)
	}
	fake.SetStats(cid, docker.Stats{CPUTotalNs: 2e9, SystemCPUNs: 20e9, OnlineCPUs: 2, MemBytes: 1 << 30, MemLimit: 3 << 30})
	b := sm.Sample(ctx, t0.Add(10*time.Second))
	if b == nil || b.Host == nil || len(b.Servers) != 1 {
		t.Fatalf("batch = %v", b)
	}
	m := b.Servers[0]
	if m.ServerId != "a" || m.CpuPct != 20 || !m.McOnline || m.PlayersOnline != 2 || m.Tps == nil || *m.Tps != 19.5 {
		t.Fatalf("sample = %+v", m)
	}
	// The store's spec (PAPER, rconPassword "abcdefgh") decides the TPS probe.
	if dialed != "mcsm-alpha|abcdefgh" {
		t.Fatalf("dial = %q", dialed)
	}
}

func TestDialRconNeverReturnsTypedNil(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := dialRcon(ctx, "127.0.0.1", 1, "x") // nobody listens on port 1
	if err == nil || c != nil {
		t.Fatalf("c = %#v, err = %v", c, err)
	}
}
