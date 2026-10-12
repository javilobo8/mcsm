import { useQuery } from "@tanstack/react-query";
import type { ImportCandidateDto } from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

/** Candidatos a importar de un nodo: se piden al abrir la página y con «Volver a buscar» (cada escaneo inspecciona Docker). */
export function useImportCandidates(nodeId: string) {
  return useQuery({
    queryKey: ["import-candidates", nodeId],
    queryFn: () => api.get<ImportCandidateDto[]>(apiPath`/api/nodes/${nodeId}/import/candidates`),
    retry: false, refetchOnWindowFocus: false, staleTime: 0,
  });
}
