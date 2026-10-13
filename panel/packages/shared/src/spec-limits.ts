import type { z } from "zod";

/**
 * Spec size caps (audit L1), equal to the agent's (agent/internal/spec/limits.go):
 * lists ≤ 1000 elements and strings ≤ 4 KiB in UTF-8 bytes. List entries and URLs are already
 * bounded by their regexes (300 and ~1000 bytes). The generated env (≤ 96 KiB) is only computed by the agent: here it is
 * amply bounded by the 64 KiB cap on the serialized spec, which the panel applies.
 */
export const MAX_LIST_ITEMS = 1000;
export const MAX_STRING_BYTES = 4096;
/** Cap on the serialized spec (JSON, UTF-8 bytes) after the PATCH merge: 60 servers × 64 KiB < 4 MiB of SyncSpecs. */
export const SPEC_MAX_BYTES = 64 * 1024;

export const LIST_MAX_MESSAGE = `Too many elements (max. ${MAX_LIST_ITEMS})`;

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

/** Base spec strings (content sections are already bounded by their regexes) and number of extra ports. */
export function limitsCheck(s: LimitShape, ctx: z.RefinementCtx) {
  const tooLong = (path: (string | number)[], v: string) => {
    const n = utf8Bytes(v);
    if (n > MAX_STRING_BYTES) ctx.addIssue({ code: "custom", path, message: `Too long: ${n} bytes (max. ${MAX_STRING_BYTES})` });
  };
  for (const k of ["type", "version", "memory", "imageTag"] as const) tooLong([k], s[k]);
  tooLong(["resources", "memLimit"], s.resources.memLimit);
  if (s.rconPassword !== undefined) tooLong(["rconPassword"], s.rconPassword);
  for (const [k, v] of Object.entries(s.env)) { tooLong(["env", k], k); tooLong(["env", k], v); }
  for (const [k, v] of Object.entries(s.properties)) { tooLong(["properties", k], k); tooLong(["properties", k], v); }
  if (s.ports && s.ports.extra.length > MAX_LIST_ITEMS) ctx.addIssue({ code: "custom", path: ["ports", "extra"], message: LIST_MAX_MESSAGE });
}

/** Message of the 400 if the serialized spec exceeds 64 KiB; null if it fits. */
export function specSizeError(spec: unknown): string | null {
  const n = utf8Bytes(JSON.stringify(spec));
  return n > SPEC_MAX_BYTES
    ? `The configuration takes up ${Math.ceil(n / 1024)} KiB and the maximum is ${SPEC_MAX_BYTES / 1024} KiB: trim lists, properties or environment variables`
    : null;
}
