import { z } from "zod";

/**
 * PATCH de spec: merge de primer nivel (RFC 7386 solo en la raíz).
 * - clave presente → sustituye el valor anterior entero (no se mezclan objetos anidados);
 * - clave con `null` → se borra (vuelve a su valor por defecto o a "sin sección");
 * - clave ausente → se conserva lo que había.
 * Así cada pantalla (formulario de configuración, pestaña Backups del Plan 4…) envía solo
 * las secciones que edita sin pisar las demás.
 */
export const specPatchSchema = z.record(z.string(), z.unknown());
export type SpecPatch = z.infer<typeof specPatchSchema>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mergeSpecPatch(previous: Record<string, unknown>, patch: SpecPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** JSON con las claves ordenadas: compara specs sin depender del orden de inserción. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

/** Primer error de zod con la ruta del campo delante ("modpack.slugOrUrl: …"). */
export function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Spec inválida";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
