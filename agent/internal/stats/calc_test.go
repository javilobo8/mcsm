package stats

import (
	"testing"
	"time"

	"mcsm/agent/internal/docker"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestRoundTS(t *testing.T) {
	cases := map[string]int64{
		"2026-10-12T10:00:00Z":        at("2026-10-12T10:00:00Z").Unix(),
		"2026-10-12T10:00:09.999Z":    at("2026-10-12T10:00:00Z").Unix(),
		"2026-10-12T10:00:10Z":        at("2026-10-12T10:00:10Z").Unix(),
		"2026-10-12T10:00:17.5+02:00": at("2026-10-12T08:00:10Z").Unix(),
	}
	for in, want := range cases {
		if got := RoundTS(at(in)); got != want || got%10 != 0 {
			t.Errorf("RoundTS(%s) = %d, want %d", in, got, want)
		}
	}
}

func TestNextTickIsMidWindow(t *testing.T) {
	cases := map[string]string{
		"2026-10-12T10:00:00Z":     "2026-10-12T10:00:05Z",
		"2026-10-12T10:00:04.9Z":   "2026-10-12T10:00:05Z",
		"2026-10-12T10:00:05Z":     "2026-10-12T10:00:15Z", // right on the tick: the next one
		"2026-10-12T10:00:05.001Z": "2026-10-12T10:00:15Z",
		"2026-10-12T10:00:59Z":     "2026-10-12T10:01:05Z",
	}
	for in, want := range cases {
		if got := NextTick(at(in)); !got.Equal(at(want)) {
			t.Errorf("NextTick(%s) = %s, want %s", in, got.UTC().Format(time.RFC3339Nano), want)
		}
	}
	// Consecutive ticks delayed by up to 4 s fall in consecutive windows.
	now := at("2026-10-12T10:00:01Z")
	prev := int64(0)
	for i := 0; i < 20; i++ {
		tick := NextTick(now)
		late := tick.Add(time.Duration(i%5) * 900 * time.Millisecond) // 0–3.6 s late
		ts := RoundTS(late)
		if prev != 0 && ts != prev+10 {
			t.Fatalf("tick %d: ts %d after %d (must advance 10 s)", i, ts, prev)
		}
		prev, now = ts, late
	}
}

func TestContainerCPUPercent(t *testing.T) {
	prev := docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 4}
	cur := docker.Stats{CPUTotalNs: 3e9, SystemCPUNs: 30e9, OnlineCPUs: 4}
	if got, ok := ContainerCPUPercent(prev, cur); !ok || got != 40 {
		t.Fatalf("got %v %v, want 40 true", got, ok)
	}
	// One whole core of 4: 100 %.
	if got, _ := ContainerCPUPercent(prev, docker.Stats{CPUTotalNs: 6e9, SystemCPUNs: 30e9, OnlineCPUs: 4}); got != 100 {
		t.Fatalf("got %v, want 100", got)
	}
	// Container restart: the accumulated value drops. Never an absurd value from overflow.
	if _, ok := ContainerCPUPercent(prev, docker.Stats{CPUTotalNs: 5e8, SystemCPUNs: 30e9, OnlineCPUs: 4}); ok {
		t.Fatal("reset counters must give ok=false")
	}
	if _, ok := ContainerCPUPercent(prev, docker.Stats{CPUTotalNs: 2e9, SystemCPUNs: 10e9, OnlineCPUs: 4}); ok {
		t.Fatal("without host clock advance it must give ok=false")
	}
	// Unknown OnlineCPUs: 1 is assumed.
	if got, _ := ContainerCPUPercent(docker.Stats{SystemCPUNs: 1}, docker.Stats{CPUTotalNs: 5, SystemCPUNs: 11}); got != 50 {
		t.Fatalf("got %v, want 50", got)
	}
}

// A reading without data (stopped container: all zero) is neither a 0 % nor a spike.
func TestContainerCPUPercentNoDataReading(t *testing.T) {
	good := docker.Stats{CPUTotalNs: 1e9, SystemCPUNs: 10e9, OnlineCPUs: 4, MemLimit: 1 << 30}
	empty := docker.Stats{}
	if _, ok := ContainerCPUPercent(good, empty); ok {
		t.Fatal("an empty current reading must give ok=false")
	}
	// empty prev and cur with large accumulated values: without a guard it would give a huge spike.
	if got, ok := ContainerCPUPercent(empty, good); ok {
		t.Fatalf("an empty previous reading must give ok=false, got %v", got)
	}
}

func TestHostCPUPercent(t *testing.T) {
	if got, ok := HostCPUPercent(CPUTimes{Busy: 100, Total: 1000}, CPUTimes{Busy: 150, Total: 1100}); !ok || got != 50 {
		t.Fatalf("got %v %v", got, ok)
	}
	if _, ok := HostCPUPercent(CPUTimes{Busy: 100, Total: 1000}, CPUTimes{Busy: 100, Total: 1000}); ok {
		t.Fatal("without advance it must give ok=false")
	}
	if _, ok := HostCPUPercent(CPUTimes{Busy: 100, Total: 1000}, CPUTimes{Busy: 90, Total: 1100}); ok {
		t.Fatal("counters going backwards must give ok=false")
	}
}
