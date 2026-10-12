import { useQuery } from "@tanstack/react-query";
import { api, apiPath, type BackupDto, type JobDto } from "@/lib/api";
import { backupsKey } from "@/lib/jobs";

export function useBackups(serverId: string) {
  return useQuery({ queryKey: backupsKey(serverId), queryFn: () => api.get<BackupDto[]>(apiPath`/api/servers/${serverId}/backups`) });
}

/** Una clave por intento del usuario (un reintento tras un fallo de red la reutiliza, no crea otra copia). */
export const newIdempotencyKey = (): string => crypto.randomUUID();

/** Crea una copia ahora. Devuelve el job (202). `idempotencyKey`: la misma para los reintentos del mismo clic. */
export function createBackup(serverId: string, idempotencyKey: string): Promise<JobDto> {
  return api.post<JobDto>(apiPath`/api/servers/${serverId}/backups`, undefined, { "Idempotency-Key": idempotencyKey });
}
