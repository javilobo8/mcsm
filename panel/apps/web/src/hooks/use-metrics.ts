import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MetricRange, MetricSeries } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";
import { realtime } from "@/lib/ws";
import { REFRESH_MS, bindNodeMetrics, latestNodeSample } from "@/lib/metrics";

/** Serie histórica de un servidor; se recarga al ritmo del cubo del rango. */
export function useServerMetrics(serverId: string, range: MetricRange) {
  return useQuery({
    queryKey: ["metrics", "server", serverId, range],
    queryFn: () => api.get<MetricSeries>(`${apiPath`/api/servers/${serverId}/metrics`}?range=${range}`),
    refetchInterval: REFRESH_MS[range],
  });
}

/** Última muestra de un nodo: la primera por REST y después en vivo por el WS (`node_metrics`). */
export function useNodeLive(nodeId: string) {
  const qc = useQueryClient();
  useEffect(() => bindNodeMetrics(qc, realtime), [qc]);
  return useQuery({
    queryKey: ["node-live", nodeId],
    queryFn: async () => latestNodeSample(await api.get<MetricSeries>(`${apiPath`/api/nodes/${nodeId}/metrics`}?range=1h`)),
    staleTime: Infinity,
  });
}
