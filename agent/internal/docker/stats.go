package docker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"
)

// Stats pide una sola muestra (`stream=false&one-shot=true`): responde al instante,
// sin el segundo de espera que necesita Docker para rellenar precpu_stats.
func (m *Moby) Stats(ctx context.Context, id string) (Stats, error) {
	res, err := m.cli.ContainerStats(ctx, id, client.ContainerStatsOptions{Stream: false, IncludePreviousSample: false})
	if err != nil {
		return Stats{}, notFound(err)
	}
	defer res.Body.Close()
	var s container.StatsResponse
	if err := json.NewDecoder(res.Body).Decode(&s); err != nil {
		return Stats{}, fmt.Errorf("docker: decodificar stats: %w", err)
	}
	return statsFrom(&s), nil
}

// statsFrom reduce la respuesta de Docker a lo que usa el muestreador.
func statsFrom(s *container.StatsResponse) Stats {
	out := Stats{
		Read:        s.Read,
		CPUTotalNs:  s.CPUStats.CPUUsage.TotalUsage,
		SystemCPUNs: s.CPUStats.SystemUsage,
		OnlineCPUs:  s.CPUStats.OnlineCPUs,
		MemBytes:    memWithoutCache(s.MemoryStats),
		MemLimit:    s.MemoryStats.Limit,
	}
	if out.OnlineCPUs == 0 {
		out.OnlineCPUs = uint32(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	for _, n := range s.Networks {
		out.NetRxBytes += n.RxBytes
		out.NetTxBytes += n.TxBytes
	}
	return out
}

// memWithoutCache replica el cálculo de la CLI de Docker: uso menos la caché de
// páginas inactiva (cgroup v1: total_inactive_file; cgroup v2: inactive_file).
func memWithoutCache(m container.MemoryStats) uint64 {
	if v, ok := m.Stats["total_inactive_file"]; ok && v < m.Usage {
		return m.Usage - v
	}
	if v := m.Stats["inactive_file"]; v < m.Usage {
		return m.Usage - v
	}
	return m.Usage
}
