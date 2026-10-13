import { useQuery } from "@tanstack/react-query";
import { api, apiPath, type BackupDto, type JobDto } from "@/lib/api";
import { backupsKey } from "@/lib/jobs";
import { randomId } from "@/lib/random-id";

export function useBackups(serverId: string) {
  return useQuery({ queryKey: backupsKey(serverId), queryFn: () => api.get<BackupDto[]>(apiPath`/api/servers/${serverId}/backups`) });
}

/** One key per user attempt (a retry after a network failure reuses it, it does not create another backup). */
export const newIdempotencyKey = (): string => randomId();

/** Creates a backup now. Returns the job (202). `idempotencyKey`: the same one for retries of the same click. */
export function createBackup(serverId: string, idempotencyKey: string): Promise<JobDto> {
  return api.post<JobDto>(apiPath`/api/servers/${serverId}/backups`, undefined, { "Idempotency-Key": idempotencyKey });
}
