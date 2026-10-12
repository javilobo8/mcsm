import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OPEN_PHASES, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput } from "@mcsm/shared";
import { api, apiPath, type JobDto } from "@/lib/api";
import { backupsKey } from "@/lib/jobs";
import { activeMigrationJob, migrationFinished, migrationKey, proposalKey } from "@/lib/migration";

/** Última migración del servidor (o null). Mientras está abierta se refresca cada 15 s (lo pendiente cambia sin job). */
export function useMigration(serverId: string) {
  return useQuery({
    queryKey: migrationKey(serverId),
    queryFn: async () => (await api.get<{ migration: MigrationDto | null }>(apiPath`/api/servers/${serverId}/migration`)).migration,
    refetchInterval: (q) => (q.state.data && OPEN_PHASES.has(q.state.data.phase) ? 15_000 : false),
  });
}

/** Slug y puerto que propone el panel para el destino elegido. */
export function useMigrationProposal(serverId: string, targetNodeId: string | null) {
  return useQuery({
    queryKey: proposalKey(serverId, targetNodeId ?? ""),
    queryFn: () => api.get<MigrationProposalDto>(`${apiPath`/api/servers/${serverId}/migration/proposal`}?${new URLSearchParams({ targetNodeId: targetNodeId ?? "" })}`),
    enabled: targetNodeId !== null,
    retry: false,
  });
}

export function startMigration(serverId: string, body: MigrationRequestInput): Promise<JobDto> {
  return api.post<JobDto>(apiPath`/api/servers/${serverId}/migration`, body);
}

/** Al terminar la migración en curso, refresca el servidor (quizá ya en otro nodo), la lista, la migración y sus copias. */
export function useMigrationSync(serverId: string, jobs: JobDto[] | undefined) {
  const qc = useQueryClient();
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (migrationFinished(prev.current, jobs)) {
      void qc.invalidateQueries({ queryKey: ["server", serverId] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: migrationKey(serverId) });
      void qc.invalidateQueries({ queryKey: backupsKey(serverId) });
    }
    prev.current = activeMigrationJob(jobs)?.id ?? null;
  }, [jobs, qc, serverId]);
}
