import {
  MODPACK_PLATFORMS, canonicalJson, formatZodError, specInputSchema, templateSpecSchema,
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
    return { ...spec, type, modpack: { platform: type, slugOrUrl: prev?.slugOrUrl ?? "", versionId: "", loader: "" } };
  }
  const { modpack: _drop, ...rest } = spec;
  return { ...rest, type };
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
