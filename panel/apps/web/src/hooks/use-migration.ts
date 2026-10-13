import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OPEN_PHASES, type MigrationDto, type MigrationProposalDto, type MigrationRequestInput } from "@mcsm/shared";
import { api, apiPath, type JobDto } from "@/lib/api";
import { backupsKey } from "@/lib/jobs";
import { migrationKey, migrationSync, proposalKey, proposalPath, type MigrationSyncState } from "@/lib/migration";

/** Latest migration of the server (or null). While it is open it refreshes every 15 s (what is pending changes without a job). */
export function useMigration(serverId: string) {
  return useQuery({
    queryKey: migrationKey(serverId),
    queryFn: async () => (await api.get<{ migration: MigrationDto | null }>(apiPath`/api/servers/${serverId}/migration`)).migration,
    refetchInterval: (q) => (q.state.data && OPEN_PHASES.has(q.state.data.phase) ? 15_000 : false),
  });
}

/** Slug and port the panel proposes for the chosen target (with the port typed in, if any, it checks that one). */
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

/** Manual close of a stuck migration (it stops retrying what is pending). */
export function closeMigration(serverId: string): Promise<{ migration: MigrationDto }> {
  return api.post<{ migration: MigrationDto }>(apiPath`/api/servers/${serverId}/migration/close`);
}

/**
 * Refreshes the server (maybe already on another node), the list, the migration and its backups when the migration in progress
 * reaches step 7 (node change confirmed) and when it ends.
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
