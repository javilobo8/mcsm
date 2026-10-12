import { z } from "zod";

/** Límite de lectura/escritura inline (spec §6.6); lo más grande va por transferencia. */
export const INLINE_MAX_BYTES = 2 * 1024 * 1024;

/** Entrada de un listado de archivos tal y como la sirve la API. */
export interface FileEntryDto {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  /** epoch en milisegundos */
  modifiedAt: number;
  /** bits de permisos (0o644…) */
  mode: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Igual que `files.Clean` del agente: 4096 bytes UTF-8, no unidades UTF-16. */
const MAX_PATH_BYTES = 4096;
/** NAME_MAX de Linux: 255 bytes UTF-8. */
const MAX_NAME_BYTES = 255;
const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Motivo por el que una ruta es insegura, o null si es válida. */
function pathProblem(p: string): string | null {
  if (byteLength(p) > MAX_PATH_BYTES) return "Ruta demasiado larga (máx. 4096 bytes)";
  if (CONTROL.test(p)) return "Ruta inválida: no se permiten caracteres de control";
  if (p.split("/").includes("..")) return "Ruta inválida: no se permite «..»";
  return null;
}

/**
 * Normaliza una ruta dentro de /data del servidor ("mods//a.jar/" → "/mods/a.jar", "" → "/").
 * Devuelve null si es insegura: ".." o caracteres de control se rechazan, nunca se arreglan.
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

/** Ruta de archivo validada y normalizada (empieza por "/"). */
export const filePathSchema = z
  .string({ error: "Falta la ruta" })
  .transform((p, ctx) => {
    const problem = pathProblem(p);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", message: problem });
      return z.NEVER;
    }
    return normalizePath(p) as string;
  });

/** Nombre de un fichero o carpeta nuevo (crear carpeta, renombrar). */
export const fileNameSchema = z
  .string()
  .trim()
  .min(1, "El nombre no puede estar vacío")
  .refine((n) => byteLength(n) <= MAX_NAME_BYTES, "Nombre demasiado largo (máx. 255 bytes)")
  .refine((n) => n !== "." && n !== ".." && !n.includes("/") && !CONTROL.test(n), "Nombre inválido: sin «/», «..» ni caracteres de control");

/**
 * joinPath, parentPath y baseName esperan rutas ya normalizadas (`normalizePath` / `filePathSchema`):
 * empiezan por "/", sin "/" final ni segmentos vacíos. Con otra entrada el resultado no es fiable.
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

/** Lenguaje del editor según la extensión; null si el fichero no se abre en el editor. */
export function editorLanguage(name: string): EditorLanguage | null {
  const i = name.lastIndexOf(".");
  if (i < 0) return null;
  return LANGUAGES[name.slice(i + 1).toLowerCase()] ?? null;
}
