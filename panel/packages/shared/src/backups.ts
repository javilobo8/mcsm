import { z } from "zod";

/** Mismas exclusiones por defecto que el agente (`spec.DefaultBackupExcludes`). */
export const DEFAULT_BACKUP_EXCLUDES: readonly string[] = ["logs", "cache", "*.tmp"];

const EXCLUDE_RE = /^[A-Za-z0-9._*?-][A-Za-z0-9._*?/-]{0,199}$/;
const CRON_ITEM = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(\/\d{1,2})?$/;
const CRON_FIELDS: readonly (readonly [string, number, number])[] = [
  ["Minuto", 0, 59], ["Hora", 0, 23], ["Día del mes", 1, 31], ["Mes", 1, 12], ["Día de la semana", 0, 6],
];

/** Mismo criterio que `spec.ValidCron` del agente. Devuelve el error en castellano o null si es válida. */
export function cronError(expr: string): string | null {
  if (expr.length > 100) return "Expresión cron demasiado larga";
  const fields = expr.trim().split(/\s+/).filter((f) => f !== "");
  if (fields.length !== 5) return "La expresión cron debe tener 5 campos: minuto hora día mes día-de-la-semana";
  for (let i = 0; i < 5; i++) {
    const [name, min, max] = CRON_FIELDS[i]!;
    const field = fields[i]!;
    for (const item of field.split(",")) {
      const m = CRON_ITEM.exec(item);
      if (!m) return `Campo "${name}" no válido: ${field}`;
      if (m[1] !== "*") {
        const [lo, hi = lo] = m[1]!.split("-");
        const l = Number(lo);
        const h = Number(hi);
        if (l < min || h > max || l > h) return `${name} fuera de rango (${min}-${max})`;
      }
      if (m[2] && Number(m[2].slice(1)) < 1) return `El paso de "${name}" debe ser al menos 1`;
    }
  }
  return null;
}

const excludePattern = z
  .string()
  .regex(EXCLUDE_RE, "Patrón de exclusión inválido (sin / inicial ni corchetes; ej. logs, *.tmp, world/session.lock)")
  .refine((p) => !p.includes(".."), { message: "Un patrón de exclusión no puede contener .." });

/** Programación y retención de copias (spec §4.1 `backups`). Igual que `spec.Backups` del agente. */
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
