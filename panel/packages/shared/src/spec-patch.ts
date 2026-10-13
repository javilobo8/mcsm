import { z } from "zod";

/**
 * Spec PATCH: first-level merge (RFC 7386 only at the root).
 * - key present → replaces the whole previous value (nested objects are not merged);
 * - key with `null` → deleted (goes back to its default value or to "no section");
 * - key absent → what was there is kept.
 * This way each screen (configuration form, Plan 4 Backups tab…) sends only
 * the sections it edits without overwriting the others.
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

/** JSON with sorted keys: compares specs without depending on insertion order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

/** First zod error with the field path in front ("modpack.slugOrUrl: …"). */
export function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid spec";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
