import { useQuery } from "@tanstack/react-query";
import type { BuildListDto, VersionListDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** El panel guarda las listas 1 h (builds 15 min); aquí basta con no repetir la petición en 10 min. */
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
