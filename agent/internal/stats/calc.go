// Package stats samples the usage of the host and of running containers every 10 s
// (spec §6.4) and sends it to the panel in a MetricBatch.
package stats

import (
	"math"
	"time"

	"mcsm/agent/internal/docker"
)

// Interval is the sampling period.
const Interval = 10 * time.Second

const intervalSec = int64(Interval / time.Second)

// RoundTS returns t in epoch seconds rounded down to a multiple of 10.
func RoundTS(t time.Time) int64 {
	s := t.Unix()
	return s - s%intervalSec
}

// NextTick returns the next sampling instant: second 5 of a 10 s window
// (…:05, …:15). Sampling mid-window makes RoundTS give consecutive windows
// even if the timer is delayed by a few milliseconds.
func NextTick(now time.Time) time.Time {
	base := RoundTS(now)
	t := time.Unix(base+intervalSec/2, 0)
	if !t.After(now) {
		t = t.Add(Interval)
	}
	return t
}

// ContainerCPUPercent computes the CPU % between two readings like `docker stats`
// (100 = one full core). ok=false if there is no valid delta: a reading without data
// (SystemCPUNs == 0, typical of a stopped container), reset counters (the
// container restarted) or the host CPU clock did not advance.
func ContainerCPUPercent(prev, cur docker.Stats) (float64, bool) {
	if prev.SystemCPUNs == 0 || cur.SystemCPUNs == 0 {
		return 0, false
	}
	if cur.CPUTotalNs < prev.CPUTotalNs || cur.SystemCPUNs <= prev.SystemCPUNs {
		return 0, false
	}
	cpus := cur.OnlineCPUs
	if cpus == 0 {
		cpus = 1
	}
	cpu := float64(cur.CPUTotalNs - prev.CPUTotalNs)
	sys := float64(cur.SystemCPUNs - prev.SystemCPUNs)
	return cpu / sys * float64(cpus) * 100, true
}

// CPUTimes are the host's accumulated CPU counters, in seconds.
type CPUTimes struct{ Busy, Total float64 }

// HostCPUPercent computes the host CPU % (0–100 over all CPUs) between two
// readings. ok=false if the total did not advance or the counters went backwards.
func HostCPUPercent(prev, cur CPUTimes) (float64, bool) {
	dt := cur.Total - prev.Total
	if dt <= 0 || cur.Busy < prev.Busy {
		return 0, false
	}
	return math.Min(100, math.Max(0, (cur.Busy-prev.Busy)/dt*100)), true
}

// round1 rounds to one decimal (what the UI shows).
func round1(v float64) float64 { return math.Round(v*10) / 10 }
