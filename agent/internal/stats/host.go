package stats

import (
	"context"
	"errors"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
)

// HostReader lee el uso del host.
type HostReader interface {
	CPUTimes(ctx context.Context) (CPUTimes, error)
	// Memory devuelve la RAM usada (total - disponible) y la total.
	Memory(ctx context.Context) (used, total uint64, err error)
	// Disk devuelve el uso del sistema de ficheros que contiene path.
	Disk(ctx context.Context, path string) (used, total uint64, err error)
}

// GopsutilHost implementa HostReader con gopsutil. gopsutil lee HOST_PROC, así que con
// /proc del host montado en /host/proc (spec §6.1) mide el host y no el contenedor.
type GopsutilHost struct{}

func (GopsutilHost) CPUTimes(ctx context.Context) (CPUTimes, error) {
	ts, err := cpu.TimesWithContext(ctx, false)
	if err != nil {
		return CPUTimes{}, err
	}
	if len(ts) == 0 {
		return CPUTimes{}, errors.New("stats: sin tiempos de CPU")
	}
	return cpuTimesFrom(ts[0]), nil
}

// cpuTimesFrom replica el cálculo de gopsutil: guest y guestNice ya están incluidos
// en user y nice, así que no se suman otra vez.
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
