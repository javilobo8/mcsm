import { useQuery } from "@tanstack/react-query";
import type { ImportCandidateDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** Import candidates of a node: requested when the page opens and with “Search again” (each scan inspects Docker). */
export function useImportCandidates(nodeId: string) {
  return useQuery({
    queryKey: ["import-candidates", nodeId],
    queryFn: () => api.get<ImportCandidateDto[]>(apiPath`/api/nodes/${nodeId}/import/candidates`),
    retry: false, refetchOnWindowFocus: false, staleTime: 0,
  });
}
