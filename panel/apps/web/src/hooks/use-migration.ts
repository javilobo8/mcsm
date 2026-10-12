import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OPEN_PHASES, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput } from "@mcsm/shared";
import { api, apiPath, type JobDto } from "@/lib/api";
import { backupsKey } from "@/lib/jobs";
import { migrationKey, migrationSync, proposalKey, proposalPath, type MigrationSyncState } from "@/lib/migration";

/** Última migración del servidor (o null). Mientras está abierta se refresca cada 15 s (lo pendiente cambia sin job). */
export function useMigration(serverId: string) {
  return useQuery({
    queryKey: migrationKey(serverId),
    queryFn: async () => (await api.get<{ migration: MigrationDto | null }>(apiPath`/api/servers/${serverId}/migration`)).migration,
    refetchInterval: (q) => (q.state.data && OPEN_PHASES.has(q.state.data.phase) ? 15_000 : false),
  });
}

/** Slug y puerto que propone el panel para el destino elegido (con el puerto escrito, si lo hay, comprueba ese). */
export function useMigrationProposal(serverId: string, targetNodeId: string | null, port: number | undefined) {
  return useQuery({
    queryKey: proposalKey(serverId, targetNodeId ?? "", port),
    queryFn: () => api.get<MigrationProposalDto>(proposalPath(serverId, targetNodeId ?? "", port)),
    enabled: targetNodeId !== null,
    retry: false,
  });
}

export function startMigration(serverId: string, body: MigrationRequestInput): Promise<JobDto> {
  return api.post<JobDto>(apiPath`/api/servers/${serverId}/migration`, body);
}

/** Cierre manual de una migración atascada (deja de reintentar lo pendiente). */
export function closeMigration(serverId: string): Promise<{ migration: MigrationDto }> {
  return api.post<{ migration: MigrationDto }>(apiPath`/api/servers/${serverId}/migration/close`);
}

/**
 * Refresca el servidor (quizá ya en otro nodo), la lista, la migración y sus copias al entrar la migración en curso en
 * el paso 7 (cambio de nodo confirmado) y al terminar.
 */
export function useMigrationSync(serverId: string, jobs: JobDto[] | undefined) {
  const qc = useQueryClient();
  const prev = useRef<MigrationSyncState | null>(null);
  useEffect(() => {
    const { refresh, next } = migrationSync(prev.current, jobs);
    prev.current = next;
    if (!refresh) return;
    void qc.invalidateQueries({ queryKey: ["server", serverId] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: migrationKey(serverId) });
    void qc.invalidateQueries({ queryKey: backupsKey(serverId) });
  }, [jobs, qc, serverId]);
}
