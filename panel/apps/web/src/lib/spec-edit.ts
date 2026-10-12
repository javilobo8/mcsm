import {
  MODPACK_PLATFORMS, DIGITS_RE, ENTRY_RE, URL_RE, canonicalJson, formatZodError, specInputSchema, templateSpecSchema,
  type ModpackPlatform, type SpecInput, type SpecPatch, type TemplateSpec,
} from "@mcsm/shared";
import { TYPED_PROPERTY_KEYS } from "./spec-catalog";

/** Estado del formulario: una SpecInput (sin rconPassword). En plantillas, `ports` se ignora. */
export type EditableSpec = SpecInput;

/** Secciones de la spec que edita el formulario. Lo demás (p. ej. `backups`) no se toca nunca. */
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
] as const;

/** Una entrada por línea; también acepta comas (pegar "lithium,sodium"). */
export function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Una entrada por línea, SIN trocear por comas (así una coma o un espacio interno se detecta como error). */
export function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

export type ListItemKind = "entry" | "url" | "digits";

/** Primer ítem inválido de una lista, con un mensaje en castellano; null si todos valen. Usa las regex de @mcsm/shared. */
export function validateListItems(kind: ListItemKind, items: readonly string[]): string | null {
  const re = kind === "url" ? URL_RE : kind === "digits" ? DIGITS_RE : ENTRY_RE;
  const bad = items.find((i) => !re.test(i));
  if (bad === undefined) return null;
  const why = kind === "url" ? "debe empezar por http:// o https:// y no tener espacios ni comas"
    : kind === "digits" ? "debe ser un id numérico"
    : "no puede tener espacios ni comas";
  return `«${bad.length > 40 ? `${bad.slice(0, 40)}…` : bad}» ${why}`;
}

export function listToText(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

/** `clave=valor` por línea; `#` comenta. Lanza Error con un mensaje para el usuario. */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Línea inválida: "${line}" (usa clave=valor)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function kvToText(o: Record<string, string> | undefined): string {
  return Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** Separa las propiedades con campo tipado de las demás ("Otras propiedades"). */
export function splitProperties(props: Record<string, string>): { typed: Record<string, string>; other: Record<string, string> } {
  const typed: Record<string, string> = {};
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) (TYPED_PROPERTY_KEYS.has(k) ? typed : other)[k] = v;
  return { typed, other };
}

/** Fija (o quita, con undefined/"") una propiedad tipada. */
export function setProperty(props: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const out = { ...props };
  if (value === undefined || value === "") delete out[key];
  else out[key] = value;
  return out;
}

/** Sustituye las propiedades "otras" conservando las tipadas. */
export function replaceOtherProperties(props: Record<string, string>, other: Record<string, string>): Record<string, string> {
  return { ...splitProperties(props).typed, ...other };
}

/** Quita lo que la UI no edita como spec (rconPassword). */
export function editableSpec<T extends Record<string, unknown>>(spec: T): Omit<T, "rconPassword"> {
  const { rconPassword: _secret, ...rest } = spec;
  return rest;
}

const isPlatform = (t: string): t is ModpackPlatform => (MODPACK_PLATFORMS as readonly string[]).includes(t);

/** Cambia el tipo manteniendo coherente el modpack (tipo de modpack ⇔ sección modpack). */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  if (isPlatform(type)) {
    const prev = spec.modpack;
    // El slug solo se conserva dentro de la misma plataforma: un slug de Modrinth no vale en CurseForge.
    return { ...spec, type, modpack: { platform: type, slugOrUrl: prev?.platform === type ? prev.slugOrUrl : "", versionId: prev?.platform === type ? prev.versionId : "", loader: prev?.platform === type ? prev.loader : "" } };
  }
  const { modpack: _drop, ...rest } = spec;
  return { ...rest, type };
}

/** Aviso a mostrar junto al selector de Tipo cuando cambiar a `type` descarta o crea la sección Modpack; null si no hay efecto. */
export function typeChangeNotice(spec: EditableSpec, type: string): string | null {
  if (type === spec.type) return null;
  const prev = spec.modpack;
  if (isPlatform(type)) {
    if (prev && prev.platform !== type) {
      return prev.slugOrUrl || prev.versionId
        ? `Cambiar a ${type} vacía el modpack actual («${prev.slugOrUrl}»): cada plataforma usa sus propios identificadores.`
        : `Cambiar a ${type} reinicia la sección Modpack.`;
    }
    return prev ? null : `Cambiar a ${type} crea una sección Modpack vacía que tendrás que rellenar.`;
  }
  if (prev) return `Cambiar a ${type} descarta la sección Modpack (${prev.slugOrUrl || "sin slug"}${prev.versionId ? ` @ ${prev.versionId}` : ""}).`;
  return null;
}

/** Secciones OPCIONALES: las únicas para las que el PATCH admite `null` (eliminar). El resto se resetearía a su default. */
export const OPTIONAL_KEYS: ReadonlySet<string> = new Set(["modpack", "mods", "plugins", "whitelist", "ops"]);

/**
 * PATCH mínimo (merge de primer nivel, ver mergeSpecPatch en @mcsm/shared): solo las secciones
 * de FORM_KEYS que cambiaron; `null` para las que el formulario quitó. Nunca toca lo demás.
 */
export function buildSpecPatch(original: Record<string, unknown>, edited: Record<string, unknown>, keys: readonly string[] = FORM_KEYS): SpecPatch {
  const patch: SpecPatch = {};
  for (const k of keys) {
    const before = original[k];
    const after = edited[k];
    if (after === undefined) {
      if (before !== undefined && OPTIONAL_KEYS.has(k)) patch[k] = null;
    } else if (canonicalJson(after) !== canonicalJson(before)) {
      patch[k] = after;
    }
  }
  return patch;
}

/** Valida como lo hará el panel. Devuelve el primer error ("ruta: mensaje") o null. */
export function validateSpec(spec: EditableSpec, mode: "server" | "template"): string | null {
  if (mode === "template") {
    const { ports: _ports, ...rest } = spec;
    const r = templateSpecSchema.safeParse(rest);
    return r.success ? null : formatZodError(r.error);
  }
  const r = specInputSchema.safeParse(spec);
  return r.success ? null : formatZodError(r.error);
}

/** Estado inicial del editor de plantillas a partir de su spec. */
export function editableFromTemplate(spec: TemplateSpec): EditableSpec {
  return { ...spec, ports: { extra: [] } };
}
