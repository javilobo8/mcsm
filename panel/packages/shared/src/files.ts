import { z } from "zod";

/** Inline read/write limit (spec §6.6); anything larger goes through a transfer. */
export const INLINE_MAX_BYTES = 2 * 1024 * 1024;

/** Entry of a file listing as served by the API. */
export interface FileEntryDto {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  /** epoch in milliseconds */
  modifiedAt: number;
  /** permission bits (0o644…) */
  mode: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Same as the agent's `files.Clean`: 4096 UTF-8 bytes, not UTF-16 units. */
const MAX_PATH_BYTES = 4096;
/** Linux NAME_MAX: 255 UTF-8 bytes. */
const MAX_NAME_BYTES = 255;
const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Reason a path is unsafe, or null if valid. */
function pathProblem(p: string): string | null {
  if (byteLength(p) > MAX_PATH_BYTES) return "Path too long (max. 4096 bytes)";
  if (CONTROL.test(p)) return "Invalid path: control characters are not allowed";
  if (p.split("/").includes("..")) return "Invalid path: “..” is not allowed";
  return null;
}

/**
 * Normalizes a path inside the server's /data ("mods//a.jar/" → "/mods/a.jar", "" → "/").
 * Returns null if unsafe: ".." or control characters are rejected, never fixed.
 */
export function normalizePath(p: string): string | null {
  if (pathProblem(p) !== null) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Validated and normalized file path (starts with "/"). */
export const filePathSchema = z
  .string({ error: "Missing path" })
  .transform((p, ctx) => {
    const problem = pathProblem(p);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", message: problem });
      return z.NEVER;
    }
    return normalizePath(p) as string;
  });

/** Name of a new file or folder (create folder, rename). */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1, "The name cannot be empty")
  .refine((n) => byteLength(n) <= MAX_NAME_BYTES, "Name too long (max. 255 bytes)")
  .refine((n) => n !== "." && n !== ".." && !n.includes("/") && !CONTROL.test(n), "Invalid name: no “/”, “..” or control characters");

/**
 * joinPath, parentPath and baseName expect already normalized paths (`normalizePath` / `filePathSchema`):
 * they start with "/", with no trailing "/" or empty segments. With other input the result is unreliable.
 */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export type EditorLanguage = "properties" | "yaml" | "json" | "toml" | "text";

const LANGUAGES: Record<string, EditorLanguage> = {
  properties: "properties", ini: "properties",
  yml: "yaml", yaml: "yaml",
  json: "json", mcmeta: "json",
  toml: "toml",
  txt: "text", cfg: "text", conf: "text", log: "text", md: "text",
};

/** Editor language by extension; null if the file does not open in the editor. */
export function editorLanguage(name: string): EditorLanguage | null {
  const i = name.lastIndexOf(".");
  if (i < 0) return null;
  return LANGUAGES[name.slice(i + 1).toLowerCase()] ?? null;
}
