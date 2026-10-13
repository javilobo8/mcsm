package stats

import (
	"context"
	"testing"

	"github.com/shirou/gopsutil/v4/cpu"
)

func TestCPUTimesFromExcludesGuest(t *testing.T) {
	got := cpuTimesFrom(cpu.TimesStat{User: 50, System: 20, Idle: 100, Nice: 5, Iowait: 10, Irq: 1, Softirq: 2, Steal: 2, Guest: 30, GuestNice: 4})
	if got.Total != 190 || got.Busy != 80 {
		t.Fatalf("got %+v, want Total 190 Busy 80", got)
	}
}

// Reads the real host: it only checks that the values make sense.
func TestGopsutilHostReadsThisMachine(t *testing.T) {
	ctx := context.Background()
	h := GopsutilHost{}
	c, err := h.CPUTimes(ctx)
	if err != nil || c.Total <= 0 || c.Busy < 0 || c.Busy > c.Total {
		t.Fatalf("cpu = %+v, %v", c, err)
	}
	used, total, err := h.Memory(ctx)
	if err != nil || total == 0 || used > total {
		t.Fatalf("mem = %d/%d, %v", used, total, err)
	}
	used, total, err = h.Disk(ctx, t.TempDir())
	if err != nil || total == 0 || used > total {
		t.Fatalf("disk = %d/%d, %v", used, total, err)
	}
	if _, _, err := h.Disk(ctx, "/does/not/exist/mcsm"); err == nil {
		t.Fatal("a nonexistent path must give an error")
	}
}
