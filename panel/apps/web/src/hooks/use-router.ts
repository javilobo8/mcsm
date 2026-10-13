import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RouterDeploymentSpec, RouterDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";
import { realtime } from "@/lib/ws";
import { bindRouterLive, routerKey } from "@/lib/router";

/** Router (mc-router) of a node: over REST and then live over the WS (`router` event). */
export function useNodeRouter(nodeId: string) {
  const qc = useQueryClient();
  useEffect(() => bindRouterLive(qc, realtime, nodeId), [qc, nodeId]);
  return useQuery({ queryKey: routerKey(nodeId), queryFn: () => api.get<RouterDto>(apiPath`/api/nodes/${nodeId}/router`) });
}

export function saveRouter(nodeId: string, spec: RouterDeploymentSpec): Promise<RouterDto> {
  return api.put<RouterDto>(apiPath`/api/nodes/${nodeId}/router`, spec);
}
