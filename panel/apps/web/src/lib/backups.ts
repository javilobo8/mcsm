import { backupsSchema, type BackupsConfig } from "@mcsm/shared";
import type { BackupDto, JobDto } from "./api";

export const CRON_PRESETS = [
  { value: "daily", label: "Cada día a las 4:00", cron: "0 4 * * *" },
  { value: "6h", label: "Cada 6 horas", cron: "0 */6 * * *" },
  { value: "hourly", label: "Cada hora", cron: "0 * * * *" },
  { value: "weekly", label: "Cada domingo a las 4:00", cron: "0 4 * * 0" },
  { value: "custom", label: "Personalizada", cron: "" },
] as const;

/** Preset que corresponde a una expresión ("custom" si ninguno). */
export function presetFor(cron: string): string {
  return CRON_PRESETS.find((p) => p.cron !== "" && p.cron === cron.trim())?.value ?? "custom";
}

/** Estado del formulario de programación (los números como texto, las exclusiones una por línea). */
export interface ScheduleForm {
  enabled: boolean; cron: string; keepDays: string; keepCount: string; excludes: string; onlyIfPlayersSince: boolean;
}

export function scheduleToForm(b: BackupsConfig | undefined): ScheduleForm {
  const d = b ?? backupsSchema.parse({});
  return {
    enabled: d.enabled, cron: d.cron, keepDays: String(d.keepDays), keepCount: String(d.keepCount),
    excludes: d.excludes.join("\n"), onlyIfPlayersSince: d.onlyIfPlayersSince,
  };
}

/** Valida con el mismo esquema que el panel y el agente. */
export function formToSchedule(f: ScheduleForm): { ok: true; value: BackupsConfig } | { ok: false; error: string } {
  const num = (s: string) => (s.trim() === "" ? 0 : Number(s.trim()));
  const keepDays = num(f.keepDays);
  const keepCount = num(f.keepCount);
  if (!Number.isInteger(keepDays) || !Number.isInteger(keepCount)) {
    return { ok: false, error: "Los días y el número de copias deben ser números enteros" };
  }
  const r = backupsSchema.safeParse({
    enabled: f.enabled, cron: f.cron.trim(), keepDays, keepCount, onlyIfPlayersSince: f.onlyIfPlayersSince,
    excludes: f.excludes.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
  });
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Programación inválida" };
  return { ok: true, value: r.data };
}

/** Motivo por el que no se puede crear una copia ahora (null = se puede). */
export function toggleBusyReason(nodeOnline: boolean | undefined, active: JobDto | undefined): string | null {
  if (nodeOnline === false) return "El nodo está desconectado";
  if (active) return "Hay una copia o restauración en curso";
  return null;
}

export interface BackupActions { restore: boolean; showDownload: boolean; download: false; remove: boolean }

/** Qué botones de una fila están activos. `busy`: nodo caído o job en curso; `offline`: nodo caído. */
export function backupActions(b: Pick<BackupDto, "kind" | "status">, busy: boolean, offline: boolean): BackupActions {
  const isArchive = b.kind === "archive";
  return { restore: isArchive && b.status === "ok" && !busy, showDownload: isArchive, download: false, remove: !offline };
}

export function deleteDialogText(b: Pick<BackupDto, "kind" | "filename">): { title: string; description: string } {
  return b.kind === "directory"
    ? { title: "¿Borrar los datos anteriores a la restauración?", description: `Se borrará del nodo el directorio ${b.filename} con el mundo que había antes de restaurar. No se puede deshacer.` }
    : { title: "¿Borrar esta copia?", description: `Se borrará del nodo el fichero ${b.filename}. No se puede deshacer.` };
}

export function formatBackupDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-ES");
}
