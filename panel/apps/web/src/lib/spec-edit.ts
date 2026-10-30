import {
  MODPACK_PLATFORMS, DIGITS_RE, ENTRY_RE, URL_RE, PLAYER_RE, ENV_KEY_RE, MEMORY_RE, PROPERTY_KEY_RE, RESERVED_ENV, RESERVED_PROPS,
  canonicalJson, envSectionConflicts, formatZodError, hostnameError, javaMajor, memoryToBytes, minJavaTag, portMappingSchema, specInputSchema, templateSpecSchema,
  type ModpackPlatform, type ServerRouter, type SpecInput, type SpecPatch, type TemplateSpec,
} from "@mcsm/shared";
import { JAVA_TAGS, PROPERTY_DEFS, TYPED_PROPERTY_KEYS } from "./spec-catalog";

/** Form state: a SpecInput (without rconPassword). In templates, `ports` is ignored. */
export type EditableSpec = SpecInput;

/** Spec sections the form edits. Everything else (e.g. `backups`) is never touched. */
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
  "router", // plan-8
  "build", // plan-10
  "datapacks", // plan-11
] as const;

/** One entry per line; also accepts commas (pasting "lithium,sodium"). */
export function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** One entry per line, WITHOUT splitting on commas (so a comma or an inner space is detected as an error). */
export function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

export type ListItemKind = "entry" | "url" | "digits" | "player";

/** First invalid item of a list, with a message in English; null if all are valid. Uses the regexes of @mcsm/shared. */
export function validateListItems(kind: ListItemKind, items: readonly string[]): string | null {
  const re = kind === "url" ? URL_RE : kind === "digits" ? DIGITS_RE : kind === "player" ? PLAYER_RE : ENTRY_RE;
  const bad = items.find((i) => !re.test(i));
  if (bad === undefined) return null;
  const why = kind === "url" ? "must start with http:// or https:// and have no spaces or commas"
    : kind === "digits" ? "must be a numeric id"
    : kind === "player" ? "must be a Java name (1-16 letters, numbers or _) or a UUID"
    : "cannot have spaces or commas";
  return `“${bad.length > 40 ? `${bad.slice(0, 40)}…` : bad}” ${why}`;
}

export function listToText(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

/** `key=value` per line; `#` comments. Throws an Error with a message for the user. */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Invalid line: "${line}" (use key=value)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function kvToText(o: Record<string, string> | undefined): string {
  return Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** Splits the properties with a typed field from the rest ("Other properties"). */
export function splitProperties(props: Record<string, string>): { typed: Record<string, string>; other: Record<string, string> } {
  const typed: Record<string, string> = {};
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) (TYPED_PROPERTY_KEYS.has(k) ? typed : other)[k] = v;
  return { typed, other };
}

/** Sets (or removes, with undefined/"") a typed property. */
export function setProperty(props: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const out = { ...props };
  if (value === undefined || value === "") delete out[key];
  else out[key] = value;
  return out;
}

/** Replaces the "other" properties keeping the typed ones. */
export function replaceOtherProperties(props: Record<string, string>, other: Record<string, string>): Record<string, string> {
  return { ...splitProperties(props).typed, ...other };
}

/** Removes what the UI does not edit as spec (rconPassword). */
export function editableSpec<T extends Record<string, unknown>>(spec: T): Omit<T, "rconPassword"> {
  const { rconPassword: _secret, ...rest } = spec;
  return rest;
}

const isPlatform = (t: string): t is ModpackPlatform => (MODPACK_PLATFORMS as readonly string[]).includes(t);

/** Changes the type keeping the modpack consistent (modpack type ⇔ modpack section). Each type has its own builds: it is cleared. */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  // `build` may be missing in old specs: it is only touched if it has a value (no phantom diff).
  const base = type !== spec.type && spec.build ? { ...spec, build: "" } : spec;
  if (isPlatform(type)) {
    const prev = base.modpack;
    // The slug is only kept within the same platform: a Modrinth slug is not valid on CurseForge.
    return { ...base, type, modpack: { platform: type, slugOrUrl: prev?.platform === type ? prev.slugOrUrl : "", versionId: prev?.platform === type ? prev.versionId : "", loader: prev?.platform === type ? prev.loader : "" } };
  }
  const { modpack: _drop, ...rest } = base;
  return { ...rest, type };
}

/**
 * Changes the Minecraft version (plan 10): clears the build (each version has its own) and sets the
 * minimum Java it requires if the tag is from the catalog; a custom tag (java21-graalvm) is not
 * overwritten, it only warns if it is not enough. Returns the notice to show, or null.
 */
export function withVersion(spec: EditableSpec, version: string): { spec: EditableSpec; notice: string | null } {
  if (version === spec.version) return { spec, notice: null };
  let next: EditableSpec = { ...spec, version };
  if (spec.build) next = { ...next, build: "" };
  const need = minJavaTag(version);
  if (!need || spec.imageTag === need) return { spec: next, notice: null };
  if ((JAVA_TAGS as readonly string[]).includes(spec.imageTag)) {
    return { spec: { ...next, imageTag: need }, notice: `Java adjusted to ${need} (the one ${version} requires)` };
  }
  const have = javaMajor(spec.imageTag);
  const needMajor = javaMajor(need) ?? 0;
  return { spec: next, notice: have !== null && have < needMajor ? `The ${spec.imageTag} image is not enough for ${version}: it needs Java ${needMajor}` : null };
}

/** Notice to show next to the Type selector when changing to `type` discards or creates the Modpack section; null if there is no effect. */
export function typeChangeNotice(spec: EditableSpec, type: string): string | null {
  if (type === spec.type) return null;
  const prev = spec.modpack;
  if (isPlatform(type)) {
    if (prev && prev.platform !== type) {
      return prev.slugOrUrl || prev.versionId
        ? `Changing to ${type} clears the current modpack (“${prev.slugOrUrl}”): each platform uses its own identifiers.`
        : `Changing to ${type} resets the Modpack section.`;
    }
    return prev ? null : `Changing to ${type} creates an empty Modpack section that you will have to fill in.`;
  }
  if (prev) return `Changing to ${type} discards the Modpack section (${prev.slugOrUrl || "no slug"}${prev.versionId ? ` @ ${prev.versionId}` : ""}).`;
  return null;
}

/** OPTIONAL sections: the only ones for which the PATCH accepts `null` (remove). The rest would reset to their default. */
export const OPTIONAL_KEYS: ReadonlySet<string> = new Set(["modpack", "mods", "plugins", "datapacks", "whitelist", "ops", "router"]);

/**
 * Minimal PATCH (first-level merge, see mergeSpecPatch in @mcsm/shared): only the FORM_KEYS
 * sections that changed; `null` for those the form removed. It never touches anything else.
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

/** Validates as the panel will. Returns the first error ("path: message") or null. */
export function validateSpec(spec: EditableSpec, mode: "server" | "template"): string | null {
  if (mode === "template") {
    const { ports: _ports, ...rest } = spec;
    const r = templateSpecSchema.safeParse(rest);
    return r.success ? null : formatZodError(r.error);
  }
  const r = specInputSchema.safeParse(spec);
  return r.success ? null : formatZodError(r.error);
}

/** Initial state of the template editor from its spec. */
export function editableFromTemplate(spec: TemplateSpec): EditableSpec {
  return { ...spec, ports: { extra: [] } };
}

const quote = (k: string) => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

/** "Other properties": rejects invalid names and the keys managed by the agent. Null if all are valid. */
export function validateExtraProperties(kv: Record<string, string>): string | null {
  for (const k of Object.keys(kv)) {
    if (RESERVED_PROPS.has(k)) return `“${k}” is a reserved property: it is managed by the agent (server-port, enable-rcon, rcon.port and rcon.password are not edited)`;
    if (TYPED_PROPERTY_KEYS.has(k)) return `“${k}” has its own field (${PROPERTY_DEFS.find((d) => d.key === k)?.label ?? k}): use it instead of “Other properties”`;
    if (!PROPERTY_KEY_RE.test(k)) return `“${quote(k)}” is not a valid property name (lowercase letters, numbers, . _ -)`;
  }
  return null;
}

/** Extra environment variables: valid names, without the reserved ones or CF_API_KEY. Null if all are valid. */
export function validateEnv(kv: Record<string, string>): string | null {
  for (const k of Object.keys(kv)) {
    if (k === "CF_API_KEY") return "CF_API_KEY cannot be set here: the CurseForge API key is configured separately (Settings)";
    if (RESERVED_ENV.has(k)) return `“${k}” is a reserved variable: it is generated by other sections (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES)`;
    if (!ENV_KEY_RE.test(k)) return `“${quote(k)}” is not a valid variable name (letters, numbers and _; it cannot start with a number)`;
  }
  return null;
}

/**
 * Players section errors caused by free env variables that would override it (OPS with the managed operators
 * list, ENABLE_WHITELIST with the whitelist…). Computed ids: sf-ops-env and sf-whitelist-env.
 */
export function playersEnvErrors(spec: EditableSpec): { "sf-ops-env": string | null; "sf-whitelist-env": string | null } {
  const conflicts = envSectionConflicts(spec);
  const join = (section: "ops" | "whitelist") => conflicts.filter((c) => c.section === section).map((c) => c.message).join(" · ") || null;
  return { "sf-ops-env": join("ops"), "sf-whitelist-env": join("whitelist") };
}

/** JVM memory (MEMORY): 4G, 512M… without leading zeros. */
export function validateMemory(m: string): string | null {
  return MEMORY_RE.test(m) ? null : "Invalid memory format: a whole number and M or G (e.g. 4G, 512M)";
}

/** Container RAM limit: empty (the agent applies memory + 1G) or valid memory and not lower than the JVM's. */
export function validateMemLimit(limit: string, memory: string): string | null {
  if (limit === "") return null;
  const bad = validateMemory(limit);
  if (bad) return bad;
  if (MEMORY_RE.test(memory) && memoryToBytes(limit) < memoryToBytes(memory)) return `The limit (${limit}) cannot be lower than the JVM memory (${memory})`;
  return null;
}

/** "Publish RCON" switch: on keeps `previous` (the saved/last typed port) or asks the panel for one ("auto"); off removes it. */
export function withRconPublished(spec: EditableSpec, on: boolean, previous?: number): EditableSpec {
  const { rcon: _drop, ...ports } = spec.ports;
  return on ? { ...spec, ports: { ...ports, rcon: previous ?? "auto" } } : { ...spec, ports };
}

/** Port typed in the RCON field: empty = let the panel choose ("auto"). */
export function withRconPort(spec: EditableSpec, port: number | undefined): EditableSpec {
  return { ...spec, ports: { ...spec.ports, rcon: port ?? "auto" } };
}

/** Message the API schema gives for `ports.rcon` (same as the game/extra port collision, range…), or null. */
export function rconPortError(spec: EditableSpec): string | null {
  const r = specInputSchema.safeParse(spec);
  if (r.success) return null;
  const issue = r.error.issues.find((i) => i.path[0] === "ports" && i.path[1] === "rcon");
  return issue ? `Published RCON port: ${issue.message}` : null;
}

/** Extra ports with the same schema as the API (ranges, proto and no publishing RCON 25575). First error "Extra port #n: …" or null. */
export function validateExtraPorts(extra: readonly EditableSpec["ports"]["extra"][number][]): string | null {
  for (const [i, e] of extra.entries()) {
    const r = portMappingSchema.safeParse(e);
    if (!r.success) return `Extra port #${i + 1}: ${r.error.issues[0]?.message ?? "invalid"}`;
  }
  return null;
}

/**
 * Number from the text of a numeric field (non-negative, decimal with point or comma), tolerating a trailing separator
 * while editing ("0." / "0,"). undefined if empty and NaN if invalid: invalid is NOT empty (otherwise a
 * remote replacement with empty would not resync a field with invalid text).
 */
export function parseNumberText(text: string): number | undefined {
  const raw = text.trim();
  if (raw === "") return undefined;
  const t = raw.replace(/[.,]$/, "");
  return /^[0-9]+([.,][0-9]+)?$/.test(t) ? Number(t.replace(",", ".")) : Number.NaN;
}

/**
 * What was typed in a NumberField: empty → undefined; valid → number; otherwise the error message.
 * Decimal digits only (no "0x10" or "1e3"); with integer=false it accepts a decimal with point or comma
 * and the intermediate states while typing ("0." is 0), so as not to show a transient error.
 */
export function readNumberField(text: string, o: { label: string; integer: boolean; min?: number; max?: number }): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  const n = o.integer ? (/^[0-9]+$/.test(t) ? Number(t) : Number.NaN) : (parseNumberText(t) ?? Number.NaN);
  if (Number.isFinite(n) && (o.min === undefined || n >= o.min) && (o.max === undefined || n <= o.max)) return { ok: true, value: n };
  const range = o.min !== undefined && o.max !== undefined ? ` between ${o.min} and ${o.max}` : o.min !== undefined ? ` ≥ ${o.min}` : "";
  return { ok: false, error: `${o.label}: must be ${o.integer ? "an integer" : "a number"}${range}` };
}

/**
 * Should a numeric field replace its local text with the incoming value from the parent?
 * Not if it is the echo of what was emitted, nor if the text being edited already has the same value ("0.", "0,5" while typing).
 * `zeroIsEmpty`: the field uses 0 as "empty" (e.g. CPUs), so 0 and undefined are equivalent.
 */
export function shouldResyncNumber(o: { text: string; incoming: number | undefined; emitted: number | undefined; zeroIsEmpty?: boolean }): boolean {
  const norm = (v: number | undefined) => (o.zeroIsEmpty && v === 0 ? undefined : v);
  if (norm(o.incoming) === norm(o.emitted)) return false;
  return norm(parseNumberText(o.text)) !== norm(o.incoming);
}

// plan-8: router section (mc-router)

/** Sets the router section; disabled and without a hostname it goes back to “absent” (nothing is sent or versioned). */
export function withRouter(spec: EditableSpec, router: ServerRouter): EditableSpec {
  if (!router.enabled && router.hostname === "") {
    const { router: _router, ...rest } = spec;
    return rest;
  }
  return { ...spec, router };
}

/** Router hostname error (same rules as the API); null if valid or the section is absent. */
export function routerSectionError(router: ServerRouter | undefined): string | null {
  if (!router) return null;
  if (router.enabled && router.hostname === "") return "Specify the hostname to join through the router";
  return hostnameError(router.hostname);
}
