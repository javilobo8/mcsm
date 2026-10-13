import { useQuery } from "@tanstack/react-query";
import type { MetricRange, MetricSeries } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";
import { REFRESH_MS, entryFromSeries } from "@/lib/metrics";

/** Historical series of a server; reloads at the pace of the range bucket. */
export function useServerMetrics(serverId: string, range: MetricRange) {
  return useQuery({
    queryKey: ["metrics", "server", serverId, range],
    queryFn: () => api.get<MetricSeries>(`${apiPath`/api/servers/${serverId}/metrics`}?range=${range}`),
    refetchInterval: REFRESH_MS[range],
  });
}

/** Latest sample of a node: the first one over REST and then live over the WS (`node_metrics`, bound once in `useLive`). */
export function useNodeLive(nodeId: string) {
  return useQuery({
    queryKey: ["node-live", nodeId],
    queryFn: async () => entryFromSeries(await api.get<MetricSeries>(`${apiPath`/api/nodes/${nodeId}/metrics`}?range=1h`), Date.now()),
    staleTime: Infinity,
  });
}

/** Historical series of a node (node detail). */
export function useNodeMetrics(nodeId: string, range: MetricRange) {
  return useQuery({
    queryKey: ["metrics", "node", nodeId, range],
    queryFn: () => api.get<MetricSeries>(`${apiPath`/api/nodes/${nodeId}/metrics`}?range=${range}`),
    refetchInterval: REFRESH_MS[range],
  });
}
