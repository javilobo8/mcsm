import { backupsSchema, type BackupsConfig } from "@mcsm/shared";
import { ApiError, apiPath, type BackupDto, type JobDto } from "./api";
import type { GuardText } from "./tab-guard";

export const CRON_PRESETS = [
  { value: "daily", label: "Every day at 4:00", cron: "0 4 * * *" },
  { value: "6h", label: "Every 6 hours", cron: "0 */6 * * *" },
  { value: "hourly", label: "Every hour", cron: "0 * * * *" },
  { value: "weekly", label: "Every Sunday at 4:00", cron: "0 4 * * 0" },
  { value: "custom", label: "Custom", cron: "" },
] as const;

/** Preset matching an expression ("custom" if none). */
export function presetFor(cron: string): string {
  return CRON_PRESETS.find((p) => p.cron !== "" && p.cron === cron.trim())?.value ?? "custom";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The backup schedule on one line, to show it read-only where it is not edited (template
 * editor, wizard summary): “0 4 * * * (every day at 4:00) · at most 10 backups and 7 days”.
 * null if the spec has no `backups` section.
 */
export function scheduleSummary(b: BackupsConfig | undefined): string | null {
  if (!b) return null;
  if (!b.enabled) return "disabled";
  const preset = CRON_PRESETS.find((p) => p.cron !== "" && p.cron === b.cron.trim());
  const when = preset ? `${b.cron} (${preset.label.toLowerCase()})` : b.cron;
  const keep = [b.keepCount > 0 ? plural(b.keepCount, "backup", "backups") : "", b.keepDays > 0 ? plural(b.keepDays, "day", "days") : ""].filter(Boolean);
  return `${when} · ${keep.length ? `at most ${keep.join(" and ")}` : "no retention limit"}`;
}

/** Notice for “Save as template”: the template takes the server's backup schedule with it. */
export function templateScheduleNote(b: BackupsConfig | undefined): string | null {
  const summary = scheduleSummary(b);
  return summary ? `Includes the backup schedule (${summary}): servers created from the template inherit it.` : null;
}

/** State of the schedule form (numbers as text, exclusions one per line). */
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

/** Non-negative decimal integer ("" = 0); null if it is not one (no "1e2", "0x10", "-1" or "2.5"). */
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
    ? { title: "Unsaved schedule", description: "There are unsaved changes in the backup schedule. If you leave, they will be lost.", confirmLabel: "Discard and leave" }
    : null;
}

const sameForm = (a: ScheduleForm, b: ScheduleForm) => JSON.stringify(a) === JSON.stringify(b);

/** When the server's spec changes: adopted only if the form has no unsaved changes. `base` = last server value seen. */
export function resyncSchedule(current: ScheduleForm, base: ScheduleForm, incoming: ScheduleForm): { form: ScheduleForm; base: ScheduleForm } {
  return { form: sameForm(current, base) ? incoming : current, base: incoming };
}

/** Validates with the same schema as the panel and the agent. */
export function formToSchedule(f: ScheduleForm): { ok: true; value: BackupsConfig } | { ok: false; error: string } {
  const keepDays = parseRetention(f.keepDays);
  const keepCount = parseRetention(f.keepCount);
  if (keepDays === null || keepCount === null) {
    return { ok: false, error: "The days and the number of backups must be integers" };
  }
  const r = backupsSchema.safeParse({
    enabled: f.enabled, cron: f.cron.trim(), keepDays, keepCount, onlyIfPlayersSince: f.onlyIfPlayersSince,
    excludes: f.excludes.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
  });
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Invalid schedule" };
  return { ok: true, value: r.data };
}

/** Reason why a backup cannot be created now (null = it can). */
export function toggleBusyReason(nodeOnline: boolean | undefined, active: JobDto | undefined): string | null {
  if (nodeOnline === false) return "The node is offline";
  if (active) return "A backup or restore is in progress";
  return null;
}

export interface BackupActions { restore: boolean; showDownload: boolean; download: boolean; remove: boolean }

/** Which buttons of a row are active. `busy`: node down or job in progress; `offline`: node down. */
export function backupActions(b: Pick<BackupDto, "kind" | "status">, busy: boolean, offline: boolean): BackupActions {
  const isArchive = b.kind === "archive";
  return {
    restore: isArchive && b.status === "ok" && !busy, showDownload: isArchive,
    download: isArchive && b.status === "ok" && !offline, // plan-9: the agent uploads it with BackupPush
    remove: !offline && !busy,
  };
}

export const backupDownloadUrl = (serverId: string, backupId: string): string =>
  apiPath`/api/servers/${serverId}/backups/${backupId}/download`;

export function deleteDialogText(b: Pick<BackupDto, "kind" | "filename">): { title: string; description: string } {
  return b.kind === "directory"
    ? { title: "Delete the data from before the restore?", description: `The directory ${b.filename} with the world that existed before restoring will be deleted from the node. This cannot be undone.` }
    : { title: "Delete this backup?", description: `The file ${b.filename} will be deleted from the node. This cannot be undone.` };
}

/** Text of the restore dialog. The agent starts the server again according to its desired state, not according to how it was. */
export function restoreDialogText(serverName: string, startedAt: string): string {
  return `Restoring replaces the current world of “${serverName}” with the one from the backup of ${formatBackupDate(startedAt)}. ` +
    "The server will be stopped, the current data will be set aside in a data.pre-restore-… directory (it is not deleted, it will appear in this list) and the backup will be extracted. " +
    "Afterwards, if the server should be running (its desired state), it will be started again; otherwise it will stay stopped.";
}

export function formatBackupDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB");
}

/** After a failure, is the Idempotency-Key reused? Only if there was no response from the server (the request may or may not have arrived); with any response it is discarded. */
export function keepIdempotencyKey(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  return !(error instanceof ApiError) || error.status === 0;
}
