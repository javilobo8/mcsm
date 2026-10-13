import { z } from "zod";

/**
 * `dataPath` (plan-6, spec §6.7): host folder mounted at /data of an imported server when it is not
 * <DATA_ROOT>/<slug>/data. Same rules as agent/internal/spec/adopt.go (ValidateDataPath); the
 * cases in proto/fixtures/data-path-cases.json are tested on both sides. The agent runs as root
 * and itzg's entrypoint does chown on /data: no system areas.
 */
export const DATA_PATH_MAX_BYTES = 1024;
const SEGMENT_RE = /^[A-Za-z0-9._@+ -]+$/;
export const DENIED_DATA_PATHS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
  "/sbin", "/sys", "/usr", "/var/lib/docker", "/var/run",
] as const;

/** Is `child` equal to `parent` or under it? Clean absolute paths; compared by segments. */
export function pathWithin(child: string, parent: string): boolean {
  if (parent === "/") return child.startsWith("/");
  return child === parent || child.startsWith(`${parent}/`);
}

export const dataPathsOverlap = (a: string, b: string): boolean => pathWithin(a, b) || pathWithin(b, a);

const encoder = new TextEncoder();

/** Why `p` is not valid as a dataPath, or null. It does not know DATA_ROOT (the agent and the import check that). */
export function dataPathError(p: string): string | null {
  if (encoder.encode(p).length > DATA_PATH_MAX_BYTES) return `Path too long (max. ${DATA_PATH_MAX_BYTES} bytes)`;
  if (!p.startsWith("/")) return "Must be an absolute path";
  const segs = p.slice(1).split("/");
  if (segs.length < 2) return "Path too general: specify at least two levels";
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "Path not normalized: no //, “.” or “..”, and no trailing /";
    if (!SEGMENT_RE.test(s)) return "Unsupported characters: ASCII letters and digits, space and . _ @ + -";
  }
  const denied = DENIED_DATA_PATHS.find((d) => pathWithin(p, d));
  return denied ? `It is in a system area (${denied}): it is not mounted` : null;
}

export const dataPathSchema = z.string().superRefine((p, ctx) => {
  const e = dataPathError(p);
  if (e) ctx.addIssue({ code: "custom", message: `Data folder: ${e}` });
});

/** dataPath and scheduled backups do not coexist: the agent does not see that folder (it only mounts DATA_ROOT). Same as validateImport in Go. */
export function dataPathCheck(s: { dataPath?: string | undefined; backups?: { enabled: boolean } | undefined }, ctx: z.RefinementCtx) {
  if (s.dataPath && s.backups?.enabled) {
    ctx.addIssue({ code: "custom", path: ["backups", "enabled"], message: "Scheduled backups are not available: this server's data is outside DATA_ROOT" });
  }
}

/**
 * Spec PATCH: dataPath is only set by import (it is the adopted container's real folder). The
 * PATCH can only resend it unchanged; changing or removing it (null) is 400: removing it would recreate the server
 * over <DATA_ROOT>/<slug>/data, empty, and the world would “disappear”. `null` without a previous dataPath changes
 * nothing. The 400 message or null.
 */
export function dataPathPatchError(patch: Record<string, unknown>, previous: { dataPath?: string | undefined }): string | null {
  if (!Object.hasOwn(patch, "dataPath")) return null;
  const v = patch.dataPath;
  if (v === previous.dataPath || (v === null && previous.dataPath === undefined)) return null;
  return "The data folder (dataPath) is only set by importing a server: it cannot be changed or removed here. To move the data to DATA_ROOT, remove the server without deleting data, move the folder to DATA_ROOT/<slug>/data and import it again";
}
