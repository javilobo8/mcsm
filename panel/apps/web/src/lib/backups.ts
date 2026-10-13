import { backupsSchema, type BackupsConfig } from "@mcsm/shared";
import { ApiError, apiPath, type BackupDto, type JobDto } from "./api";
import type { GuardText } from "./tab-guard";

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * La programación de copias en una línea, para enseñarla en solo lectura donde no se edita (editor de
 * plantillas, resumen del asistente): «0 4 * * * (cada día a las 4:00) · como máximo 10 copias y 7 días».
 * null si la spec no trae sección `backups`.
 */
export function scheduleSummary(b: BackupsConfig | undefined): string | null {
  if (!b) return null;
  if (!b.enabled) return "desactivadas";
  const preset = CRON_PRESETS.find((p) => p.cron !== "" && p.cron === b.cron.trim());
  const when = preset ? `${b.cron} (${preset.label.toLowerCase()})` : b.cron;
  const keep = [b.keepCount > 0 ? plural(b.keepCount, "copia", "copias") : "", b.keepDays > 0 ? plural(b.keepDays, "día", "días") : ""].filter(Boolean);
  return `${when} · ${keep.length ? `como máximo ${keep.join(" y ")}` : "sin límite de retención"}`;
}

/** Aviso de «Guardar como plantilla»: la plantilla se lleva la programación de copias del servidor. */
export function templateScheduleNote(b: BackupsConfig | undefined): string | null {
  const summary = scheduleSummary(b);
  return summary ? `Incluye la programación de copias (${summary}): los servidores creados con la plantilla la heredan.` : null;
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

export function scheduleDirty(f: ScheduleForm, base: ScheduleForm): boolean {
  return JSON.stringify(f) !== JSON.stringify(base);
}

export function scheduleLeaveWarning(dirty: boolean): GuardText | null {
  return dirty
    ? { title: "Programación sin guardar", description: "Hay cambios sin guardar en la programación de copias. Si sales, se perderán.", confirmLabel: "Descartar y salir" }
    : null;
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

export interface BackupActions { restore: boolean; showDownload: boolean; download: boolean; remove: boolean }

/** Qué botones de una fila están activos. `busy`: nodo caído o job en curso; `offline`: nodo caído. */
export function backupActions(b: Pick<BackupDto, "kind" | "status">, busy: boolean, offline: boolean): BackupActions {
  const isArchive = b.kind === "archive";
  return {
    restore: isArchive && b.status === "ok" && !busy, showDownload: isArchive,
    download: isArchive && b.status === "ok" && !offline, // plan-9: el agente la sube con BackupPush
    remove: !offline && !busy,
  };
}

export const backupDownloadUrl = (serverId: string, backupId: string): string =>
  apiPath`/api/servers/${serverId}/backups/${backupId}/download`;

export function deleteDialogText(b: Pick<BackupDto, "kind" | "filename">): { title: string; description: string } {
  return b.kind === "directory"
    ? { title: "¿Borrar los datos anteriores a la restauración?", description: `Se borrará del nodo el directorio ${b.filename} con el mundo que había antes de restaurar. No se puede deshacer.` }
    : { title: "¿Borrar esta copia?", description: `Se borrará del nodo el fichero ${b.filename}. No se puede deshacer.` };
}

/** Texto del diálogo de restaurar. El agente vuelve a arrancar el servidor según su estado deseado, no según cómo estaba. */
export function restoreDialogText(serverName: string, startedAt: string): string {
  return `Restaurar sustituye el mundo actual de «${serverName}» por el de la copia del ${formatBackupDate(startedAt)}. ` +
    "Se parará el servidor, los datos actuales se apartarán en un directorio data.pre-restore-… (no se borran, aparecerá en esta lista) y se extraerá la copia. " +
    "Después, si el servidor debe estar en marcha (su estado deseado), se volverá a arrancar; si no, se quedará parado.";
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
