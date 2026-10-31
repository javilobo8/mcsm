import { useQuery } from "@tanstack/react-query";
import type { FileEntryDto } from "@mcsm/shared";
import { api, apiPath, ApiError } from "@/lib/api";

/**
 * Does the server's world folder exist on its node? true = a directory; false = 404 (or not a folder); null = unknown
 * (loading, node offline, any other error), which callers treat as "has a world".
 */
export function useWorldExists(serverId: string, levelName: string, enabled: boolean): boolean | null {
  const q = useQuery({
    queryKey: ["world-exists", serverId, levelName],
    queryFn: async () => {
      try {
        return (await api.get<FileEntryDto>(apiPath`/api/servers/${serverId}/files/stat?path=${levelName}`)).dir;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return false;
        throw e;
      }
    },
    enabled, retry: false, staleTime: 30_000,
  });
  return q.data ?? null;
}
