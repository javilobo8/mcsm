import { backupsSchema, type BackupsConfig } from "@mcsm/shared";
import { ApiError, type BackupDto, type JobDto } from "./api";

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

/** Entero decimal no negativo ("" = 0); null si no lo es (nada de "1e2", "0x10", "-1" ni "2.5"). */
export function parseRetention(s: string): number | null {
  const t = s.trim();
  if (t === "") return 0;
  return /^\d+$/.test(t) ? Number(t) : null;
}

const sameForm = (a: ScheduleForm, b: ScheduleForm) => JSON.stringify(a) === JSON.stringify(b);

/** Al cambiar la spec del servidor: se adopta solo si el formulario no tiene cambios sin guardar. `base` = último valor del servidor visto. */
export function resyncSchedule(current: ScheduleForm, base: ScheduleForm, incoming: ScheduleForm): { form: ScheduleForm; base: ScheduleForm } {
  return { form: sameForm(current, base) ? incoming : current, base: incoming };
}

/** Valida con el mismo esquema que el panel y el agente. */
export function formToSchedule(f: ScheduleForm): { ok: true; value: BackupsConfig } | { ok: false; error: string } {
  const keepDays = parseRetention(f.keepDays);
  const keepCount = parseRetention(f.keepCount);
  if (keepDays === null || keepCount === null) {
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
  return { restore: isArchive && b.status === "ok" && !busy, showDownload: isArchive, download: false, remove: !offline && !busy };
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

/** Tras un fallo, ¿se reutiliza la Idempotency-Key? Solo si no hubo respuesta del servidor (la petición pudo llegar o no); con cualquier respuesta se descarta. */
export function keepIdempotencyKey(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  return !(error instanceof ApiError) || error.status === 0;
}
