import type { z } from "zod";

/**
 * Topes de tamaño de la spec (auditoría L1), iguales a los del agente (agent/internal/spec/limits.go):
 * listas ≤ 1000 elementos y cadenas ≤ 4 KiB en bytes UTF-8. Las entradas de lista y las URL ya las
 * acotan sus regex (300 y ~1000 bytes). El env generado (≤ 96 KiB) solo lo calcula el agente: aquí lo
 * acota de sobra el tope de 64 KiB de la spec serializada, que aplica el panel.
 */
export const MAX_LIST_ITEMS = 1000;
export const MAX_STRING_BYTES = 4096;
/** Tope de la spec serializada (JSON, bytes UTF-8) tras el merge del PATCH: 60 servidores × 64 KiB < 4 MiB de SyncSpecs. */
export const SPEC_MAX_BYTES = 64 * 1024;

export const LIST_MAX_MESSAGE = `Demasiados elementos (máx. ${MAX_LIST_ITEMS})`;

const encoder = new TextEncoder();
export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

type LimitShape = {
  type: string; version: string; memory: string; imageTag: string;
  env: Record<string, string>; properties: Record<string, string>;
  resources: { memLimit: string };
  rconPassword?: string;
  ports?: { extra: readonly { label: string }[] };
};

/** Cadenas de la spec base (las secciones de contenido ya están acotadas por sus regex) y nº de puertos extra. */
export function limitsCheck(s: LimitShape, ctx: z.RefinementCtx) {
  const tooLong = (path: (string | number)[], v: string) => {
    const n = utf8Bytes(v);
    if (n > MAX_STRING_BYTES) ctx.addIssue({ code: "custom", path, message: `Demasiado largo: ${n} bytes (máx. ${MAX_STRING_BYTES})` });
  };
  for (const k of ["type", "version", "memory", "imageTag"] as const) tooLong([k], s[k]);
  tooLong(["resources", "memLimit"], s.resources.memLimit);
  if (s.rconPassword !== undefined) tooLong(["rconPassword"], s.rconPassword);
  for (const [k, v] of Object.entries(s.env)) { tooLong(["env", k], k); tooLong(["env", k], v); }
  for (const [k, v] of Object.entries(s.properties)) { tooLong(["properties", k], k); tooLong(["properties", k], v); }
  if (s.ports && s.ports.extra.length > MAX_LIST_ITEMS) ctx.addIssue({ code: "custom", path: ["ports", "extra"], message: LIST_MAX_MESSAGE });
}

/** Mensaje del 400 si la spec serializada supera 64 KiB; null si cabe. */
export function specSizeError(spec: unknown): string | null {
  const n = utf8Bytes(JSON.stringify(spec));
  return n > SPEC_MAX_BYTES
    ? `La configuración ocupa ${Math.ceil(n / 1024)} KiB y el máximo es ${SPEC_MAX_BYTES / 1024} KiB: recorta listas, propiedades o variables de entorno`
    : null;
}
