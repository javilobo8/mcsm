import { useQuery } from "@tanstack/react-query";
import type { BuildListDto, VersionListDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** The panel keeps the lists for 1 h (builds 15 min); here it is enough not to repeat the request within 10 min. */
const STALE_MS = 10 * 60_000;

export function useVersions(type: string, enabled: boolean) {
  return useQuery({
    queryKey: ["versions", type],
    queryFn: () => api.get<VersionListDto>(apiPath`/api/versions/${type}`),
    enabled, staleTime: STALE_MS, retry: false,
  });
}

export function useBuilds(type: string, version: string, enabled: boolean) {
  return useQuery({
    queryKey: ["builds", type, version],
    queryFn: () => api.get<BuildListDto>(apiPath`/api/versions/${type}/${version}/builds`),
    enabled, staleTime: STALE_MS, retry: false,
  });
}
