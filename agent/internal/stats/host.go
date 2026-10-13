package stats

import (
	"context"
	"errors"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
)

// HostReader reads the host's usage.
type HostReader interface {
	CPUTimes(ctx context.Context) (CPUTimes, error)
	// Memory returns the used RAM (total - available) and the total.
	Memory(ctx context.Context) (used, total uint64, err error)
	// Disk returns the usage of the filesystem containing path.
	Disk(ctx context.Context, path string) (used, total uint64, err error)
}

// GopsutilHost implements HostReader with gopsutil. gopsutil reads HOST_PROC, so with the
// host's /proc mounted at /host/proc (spec §6.1) it measures the host and not the container.
type GopsutilHost struct{}

func (GopsutilHost) CPUTimes(ctx context.Context) (CPUTimes, error) {
	ts, err := cpu.TimesWithContext(ctx, false)
	if err != nil {
		return CPUTimes{}, err
	}
	if len(ts) == 0 {
		return CPUTimes{}, errors.New("stats: no CPU times")
	}
	return cpuTimesFrom(ts[0]), nil
}

// cpuTimesFrom replicates gopsutil's calculation: guest and guestNice are already included
// in user and nice, so they are not added again.
func cpuTimesFrom(t cpu.TimesStat) CPUTimes {
	total := t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal
	return CPUTimes{Busy: total - t.Idle - t.Iowait, Total: total}
}

func (GopsutilHost) Memory(ctx context.Context) (uint64, uint64, error) {
	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return 0, 0, err
	}
	used := vm.Total
	if vm.Available < vm.Total {
		used = vm.Total - vm.Available
	}
	return used, vm.Total, nil
}

func (GopsutilHost) Disk(ctx context.Context, path string) (uint64, uint64, error) {
	u, err := disk.UsageWithContext(ctx, path)
	if err != nil {
		return 0, 0, err
	}
	return u.Used, u.Total, nil
}
