import {
  MODPACK_PLATFORMS, DIGITS_RE, ENTRY_RE, URL_RE, PLAYER_RE, ENV_KEY_RE, MEMORY_RE, PROPERTY_KEY_RE, RESERVED_ENV, RESERVED_PROPS,
  canonicalJson, envSectionConflicts, formatZodError, hostnameError, memoryToBytes, portMappingSchema, specInputSchema, templateSpecSchema,
  type ModpackPlatform, type ServerRouter, type SpecInput, type SpecPatch, type TemplateSpec,
} from "@mcsm/shared";
import { PROPERTY_DEFS, TYPED_PROPERTY_KEYS } from "./spec-catalog";

/** Estado del formulario: una SpecInput (sin rconPassword). En plantillas, `ports` se ignora. */
export type EditableSpec = SpecInput;

/** Secciones de la spec que edita el formulario. Lo demás (p. ej. `backups`) no se toca nunca. */
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "router", // plan-8
] as const;

/** Una entrada por línea; también acepta comas (pegar "lithium,sodium"). */
export function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Una entrada por línea, SIN trocear por comas (así una coma o un espacio interno se detecta como error). */
export function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

export type ListItemKind = "entry" | "url" | "digits" | "player";

/** Primer ítem inválido de una lista, con un mensaje en castellano; null si todos valen. Usa las regex de @mcsm/shared. */
export function validateListItems(kind: ListItemKind, items: readonly string[]): string | null {
  const re = kind === "url" ? URL_RE : kind === "digits" ? DIGITS_RE : kind === "player" ? PLAYER_RE : ENTRY_RE;
  const bad = items.find((i) => !re.test(i));
  if (bad === undefined) return null;
  const why = kind === "url" ? "debe empezar por http:// o https:// y no tener espacios ni comas"
    : kind === "digits" ? "debe ser un id numérico"
    : kind === "player" ? "debe ser un nombre de Java (1-16 letras, números o _) o un UUID"
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
export const OPTIONAL_KEYS: ReadonlySet<string> = new Set(["modpack", "mods", "plugins", "whitelist", "ops", "router"]);

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

const quote = (k: string) => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

/** "Otras propiedades": rechaza nombres inválidos y las claves que gestiona el agente. Null si todo vale. */
export function validateExtraProperties(kv: Record<string, string>): string | null {
  for (const k of Object.keys(kv)) {
    if (RESERVED_PROPS.has(k)) return `«${k}» es una propiedad reservada: la gestiona el agente (server-port, enable-rcon, rcon.port y rcon.password no se editan)`;
    if (TYPED_PROPERTY_KEYS.has(k)) return `«${k}» tiene su propio campo (${PROPERTY_DEFS.find((d) => d.key === k)?.label ?? k}): úsalo en lugar de «Otras propiedades»`;
    if (!PROPERTY_KEY_RE.test(k)) return `«${quote(k)}» no es un nombre de propiedad válido (minúsculas, números, . _ -)`;
  }
  return null;
}

/** Variables de entorno extra: nombres válidos, sin las reservadas ni CF_API_KEY. Null si todo vale. */
export function validateEnv(kv: Record<string, string>): string | null {
  for (const k of Object.keys(kv)) {
    if (k === "CF_API_KEY") return "CF_API_KEY no se puede fijar aquí: la API key de CurseForge se configura aparte (Ajustes)";
    if (RESERVED_ENV.has(k)) return `«${k}» es una variable reservada: la generan otras secciones (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES)`;
    if (!ENV_KEY_RE.test(k)) return `«${quote(k)}» no es un nombre de variable válido (letras, números y _; no empieza por número)`;
  }
  return null;
}

/**
 * Errores de la sección Jugadores por variables del env libre que la pisarían (OPS con la lista de
 * operadores gestionada, ENABLE_WHITELIST con la whitelist…). Ids calculados: sf-ops-env y sf-whitelist-env.
 */
export function playersEnvErrors(spec: EditableSpec): { "sf-ops-env": string | null; "sf-whitelist-env": string | null } {
  const conflicts = envSectionConflicts(spec);
  const join = (section: "ops" | "whitelist") => conflicts.filter((c) => c.section === section).map((c) => c.message).join(" · ") || null;
  return { "sf-ops-env": join("ops"), "sf-whitelist-env": join("whitelist") };
}

/** Memoria de la JVM (MEMORY): 4G, 512M… sin ceros a la izquierda. */
export function validateMemory(m: string): string | null {
  return MEMORY_RE.test(m) ? null : "Formato de memoria inválido: un número entero y M o G (ej. 4G, 512M)";
}

/** Límite de RAM del contenedor: vacío (el agente aplica memoria + 1G) o memoria válida y no menor que la de la JVM. */
export function validateMemLimit(limit: string, memory: string): string | null {
  if (limit === "") return null;
  const bad = validateMemory(limit);
  if (bad) return bad;
  if (MEMORY_RE.test(memory) && memoryToBytes(limit) < memoryToBytes(memory)) return `El límite (${limit}) no puede ser menor que la memoria de la JVM (${memory})`;
  return null;
}

/** Puertos extra con el mismo esquema que la API (rangos, proto y sin publicar RCON 25575). Primer error "Puerto extra #n: …" o null. */
export function validateExtraPorts(extra: readonly EditableSpec["ports"]["extra"][number][]): string | null {
  for (const [i, e] of extra.entries()) {
    const r = portMappingSchema.safeParse(e);
    if (!r.success) return `Puerto extra #${i + 1}: ${r.error.issues[0]?.message ?? "inválido"}`;
  }
  return null;
}

/**
 * Número de un texto de campo numérico (no negativo, decimal con punto o coma), tolerando un separador final
 * en edición ("0." / "0,"). undefined si está vacío y NaN si es inválido: inválido NO es vacío (si no, un
 * reemplazo remoto a vacío no resincronizaría un campo con texto inválido).
 */
export function parseNumberText(text: string): number | undefined {
  const raw = text.trim();
  if (raw === "") return undefined;
  const t = raw.replace(/[.,]$/, "");
  return /^[0-9]+([.,][0-9]+)?$/.test(t) ? Number(t.replace(",", ".")) : Number.NaN;
}

/**
 * Lo tecleado en un NumberField: vacío → undefined; válido → número; si no, el mensaje de error.
 * Solo dígitos decimales (nada de "0x10" ni "1e3"); con integer=false admite un decimal con punto o coma
 * y los estados intermedios al teclear ("0." vale 0), para no mostrar un error transitorio.
 */
export function readNumberField(text: string, o: { label: string; integer: boolean; min?: number; max?: number }): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  const n = o.integer ? (/^[0-9]+$/.test(t) ? Number(t) : Number.NaN) : (parseNumberText(t) ?? Number.NaN);
  if (Number.isFinite(n) && (o.min === undefined || n >= o.min) && (o.max === undefined || n <= o.max)) return { ok: true, value: n };
  const range = o.min !== undefined && o.max !== undefined ? ` entre ${o.min} y ${o.max}` : o.min !== undefined ? ` ≥ ${o.min}` : "";
  return { ok: false, error: `${o.label}: debe ser un número${o.integer ? " entero" : ""}${range}` };
}

/**
 * ¿Debe un campo numérico reemplazar su texto local por el valor entrante del padre?
 * No si es el eco de lo emitido, ni si el texto en edición ya vale lo mismo ("0.", "0,5" mientras se escribe).
 * `zeroIsEmpty`: el campo usa 0 como "vacío" (p. ej. CPUs), así que 0 y undefined son equivalentes.
 */
export function shouldResyncNumber(o: { text: string; incoming: number | undefined; emitted: number | undefined; zeroIsEmpty?: boolean }): boolean {
  const norm = (v: number | undefined) => (o.zeroIsEmpty && v === 0 ? undefined : v);
  if (norm(o.incoming) === norm(o.emitted)) return false;
  return norm(parseNumberText(o.text)) !== norm(o.incoming);
}

// ── plan-8: sección router (mc-router) ──

/** Fija la sección router; desactivada y sin hostname vuelve a «ausente» (no se envía ni versiona nada). */
export function withRouter(spec: EditableSpec, router: ServerRouter): EditableSpec {
  if (!router.enabled && router.hostname === "") {
    const { router: _router, ...rest } = spec;
    return rest;
  }
  return { ...spec, router };
}

/** Error del hostname del router (mismas reglas que la API); null si vale o la sección no está. */
export function routerSectionError(router: ServerRouter | undefined): string | null {
  if (!router) return null;
  if (router.enabled && router.hostname === "") return "Indica el hostname para entrar por el router";
  return hostnameError(router.hostname);
}
