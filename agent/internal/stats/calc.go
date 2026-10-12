// Package stats muestrea cada 10 s el uso del host y de los contenedores en marcha
// (spec §6.4) y lo envía al panel en un MetricBatch.
package stats

import (
	"math"
	"time"

	"mcsm/agent/internal/docker"
)

// Interval es el periodo de muestreo.
const Interval = 10 * time.Second

const intervalSec = int64(Interval / time.Second)

// RoundTS devuelve t en epoch segundos redondeado hacia abajo a múltiplo de 10.
func RoundTS(t time.Time) int64 {
	s := t.Unix()
	return s - s%intervalSec
}

// NextTick devuelve el próximo instante de muestreo: el segundo 5 de una ventana de
// 10 s (…:05, …:15). Muestrear a mitad de ventana hace que RoundTS dé ventanas
// consecutivas aunque el temporizador se retrase unos milisegundos.
func NextTick(now time.Time) time.Time {
	base := RoundTS(now)
	t := time.Unix(base+intervalSec/2, 0)
	if !t.After(now) {
		t = t.Add(Interval)
	}
	return t
}

// ContainerCPUPercent calcula el % de CPU entre dos lecturas como `docker stats`
// (100 = un núcleo completo). ok=false si no hay delta válido: una lectura sin datos
// (SystemCPUNs == 0, típico de un contenedor parado), contadores reiniciados (el
// contenedor se reinició) o el reloj de CPU del host no avanzó.
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

// CPUTimes son los contadores acumulados de CPU del host, en segundos.
type CPUTimes struct{ Busy, Total float64 }

// HostCPUPercent calcula el % de CPU del host (0–100 sobre todas las CPU) entre dos
// lecturas. ok=false si el total no avanzó o los contadores retrocedieron.
func HostCPUPercent(prev, cur CPUTimes) (float64, bool) {
	dt := cur.Total - prev.Total
	if dt <= 0 || cur.Busy < prev.Busy {
		return 0, false
	}
	return math.Min(100, math.Max(0, (cur.Busy-prev.Busy)/dt*100)), true
}

// round1 redondea a un decimal (lo que se muestra en la UI).
func round1(v float64) float64 { return math.Round(v*10) / 10 }
