import { z } from "zod";

/** Same default exclusions as the agent (`spec.DefaultBackupExcludes`). */
export const DEFAULT_BACKUP_EXCLUDES: readonly string[] = ["logs", "cache", "*.tmp"];

const EXCLUDE_RE = /^[A-Za-z0-9._*?-][A-Za-z0-9._*?/-]{0,199}$/;
const CRON_ITEM = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(\/\d{1,2})?$/;
const CRON_FIELDS: readonly (readonly [string, number, number])[] = [
  ["Minute", 0, 59], ["Hour", 0, 23], ["Day of month", 1, 31], ["Month", 1, 12], ["Day of week", 0, 6],
];

/** Same criterion as the agent's `spec.ValidCron`. Returns the error in English or null if valid. */
export function cronError(expr: string): string | null {
  if (expr.length > 100) return "Cron expression too long";
  // Only printable ASCII, space and tab (like the agent): JS's \s and Go's strings.Fields
  // differ on U+FEFF and U+0085.
  if (/[^\x20-\x7e\t]/.test(expr)) return "The cron expression only allows ASCII characters, spaces and tabs";
  const fields = expr.split(/[ \t]+/).filter((f) => f !== "");
  if (fields.length !== 5) return "The cron expression must have 5 fields: minute hour day month day-of-week";
  for (let i = 0; i < 5; i++) {
    const [name, min, max] = CRON_FIELDS[i]!;
    const field = fields[i]!;
    for (const item of field.split(",")) {
      const m = CRON_ITEM.exec(item);
      if (!m) return `Field "${name}" is not valid: ${field}`;
      if (m[1] !== "*") {
        const [lo, hi = lo] = m[1]!.split("-");
        const l = Number(lo);
        const h = Number(hi);
        if (l < min || h > max || l > h) return `${name} out of range (${min}-${max})`;
      }
      if (m[2] && Number(m[2].slice(1)) < 1) return `The step of "${name}" must be at least 1`;
    }
  }
  return null;
}

const excludePattern = z
  .string()
  .regex(EXCLUDE_RE, "Invalid exclusion pattern (no leading / or brackets; e.g. logs, *.tmp, world/session.lock)")
  .refine((p) => !p.includes(".."), { message: "An exclusion pattern cannot contain .." });

/** Backup schedule and retention (spec §4.1 `backups`). Same as the agent's `spec.Backups`. */
export const backupsSchema = z
  .object({
    enabled: z.boolean().default(false),
    cron: z.string().max(100).default("0 4 * * *"),
    keepDays: z.number().int().min(0).max(3650).default(7),
    keepCount: z.number().int().min(0).max(1000).default(10),
    excludes: z.array(excludePattern).max(50).default(() => [...DEFAULT_BACKUP_EXCLUDES]),
    onlyIfPlayersSince: z.boolean().default(true),
  })
  .superRefine((b, ctx) => {
    if (!b.enabled && b.cron === "") return;
    const err = cronError(b.cron);
    if (err) ctx.addIssue({ code: "custom", path: ["cron"], message: err });
  });

export type BackupsConfig = z.infer<typeof backupsSchema>;
export type BackupsInput = z.input<typeof backupsSchema>;
