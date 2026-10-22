import { z } from "zod";
import "./zod-locale.js";
import { specPatchSchema, type SpecPatch } from "./spec-patch.js";
import { contentCheck, contentFields } from "./spec-content.js";
import { limitsCheck } from "./spec-limits.js";
import { serverRouterSchema } from "./router.js";
import { backupsSchema } from "./backups.js";
import { dataPathCheck, dataPathSchema } from "./data-path.js";
import { buildCheck } from "./versions.js";

export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
  "CF_API_KEY",
]);

export const MEMORY_RE = /^[1-9]\d*[MmGg]$/;
const memory = z.string().regex(MEMORY_RE, "Invalid memory format (e.g. 4G, 512M; no zeros)");
/** itzg image tag (Docker tag grammar, no digest). Same regex as the agent. */
export const IMAGE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const port = z.number().int().min(1).max(65535);
export const PROPERTY_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const RCON_PORT = 25575;
export const RESERVED_PROPS = new Set(["server-port", "enable-rcon", "rcon.port", "rcon.password"]);

export function memoryToBytes(m: string): number {
  const n = Number(m.slice(0, -1));
  return /g$/i.test(m) ? n * 1024 ** 3 : n * 1024 ** 2;
}

export const portMappingSchema = z.object({
  host: port,
  container: port,
  proto: z.enum(["tcp", "udp"]),
  label: z.string().max(40).default(""),
}).refine((pm) => pm.container !== RCON_PORT, {
  message: "The extra port cannot publish RCON (25575)",
});

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envSchema = z
  .record(z.string().regex(ENV_KEY_RE, "Invalid variable name"), z.string())
  .refine((env) => !Object.keys(env).some((k) => RESERVED_ENV.has(k)), {
    message: "Contains a reserved variable (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES, CF_API_KEY)",
  });

const resourcesSchema = z.object({
  cpus: z.number().min(0).default(0),
  memLimit: z.union([z.literal(""), memory]).default(""),
});

const baseFields = {
  imageTag: z.string().regex(IMAGE_TAG_RE, "Invalid image tag (letters, numbers, . _ -; starts with a letter or number; max. 128)").default("latest"),
  type: z.string().min(1).default("PAPER"),
  version: z.string().min(1).default("LATEST"),
  memory: memory.default("2G"),
  properties: z
    .record(
      z.string().regex(PROPERTY_KEY_RE, "Invalid property name").refine((k) => !RESERVED_PROPS.has(k), {
        message: "The property is reserved (managed by the agent)",
      }),
      z.string().refine((v) => !/[\r\n]/.test(v), { message: "The property value cannot contain line breaks" }),
    )
    .default({}),
  env: envSchema.default({}),
  resources: resourcesSchema.prefault({}),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  // ── plan-2 ──
  // ── plan-3 ──
  ...contentFields,
  // ── plan-4 ──
  backups: backupsSchema.optional(),
  // ── plan-5 ──
  // ── plan-6 ──
  // ── plan-7 ──
  // ── plan-8 ──
  router: serverRouterSchema.optional(),
  // ── plan-9 ──
  // ── plan-10 ──
  build: z.string().default(""),
};

function memLimitCheck(s: { memory: string; resources: { memLimit: string } }, ctx: z.RefinementCtx) {
  if (s.resources.memLimit && memoryToBytes(s.resources.memLimit) < memoryToBytes(s.memory)) {
    ctx.addIssue({ code: "custom", path: ["resources", "memLimit"], message: "memLimit cannot be lower than memory" });
  }
}

/** Whole-object validations: memory and, below the anchors, those of each plan. */
function specChecks(
  s: Parameters<typeof memLimitCheck>[0] & Parameters<typeof contentCheck>[0] & Parameters<typeof limitsCheck>[0] & Parameters<typeof buildCheck>[0],
  ctx: z.RefinementCtx,
) {
  memLimitCheck(s, ctx);
  // ── plan-3 ──
  contentCheck(s, ctx);
  limitsCheck(s, ctx);
  // ── plan-10 ──
  buildCheck(s, ctx);
}

const RCON_COLLISION_MESSAGE = "The RCON port cannot be the same as the game port or an extra port";

/** `ports.rcon` cannot repeat the game port or the host port of an extra (any protocol). Same rule as the agent. */
function rconPortCheck(
  p: { game?: number; extra: { host: number }[]; rcon?: number | "auto" },
  ctx: z.RefinementCtx,
) {
  if (typeof p.rcon !== "number") return;
  if (p.rcon === p.game || p.extra.some((e) => e.host === p.rcon)) {
    ctx.addIssue({ code: "custom", path: ["rcon"], message: RCON_COLLISION_MESSAGE });
  }
}

/** Host ports a spec occupies: game, extras' hosts and the published RCON one (when present). */
export function specHostPorts(spec: { ports: { game: number; extra: { host: number }[]; rcon?: number } }): number[] {
  const { game, extra, rcon } = spec.ports;
  return rcon === undefined ? [game, ...extra.map((e) => e.host)] : [game, ...extra.map((e) => e.host), rcon];
}

/** Complete spec, as persisted and sent to the agent. */
export const specSchema = z
  .object({
    ...baseFields,
    // rcon: host port that publishes the container's 25575/tcp. Absent = not published.
    ports: z.object({ game: port, extra: z.array(portMappingSchema).default([]), rcon: port.optional() }).superRefine(rconPortCheck),
    rconPassword: z.string().min(8),
    // plan-6: server specs only (it is not in baseFields: templates do not carry it).
    dataPath: dataPathSchema.optional(),
  })
  .superRefine(specChecks)
  .superRefine(dataPathCheck);

/** What the UI sends on create/edit: the panel adds the port and rconPassword. */
export const specInputSchema = z
  .object({
    ...baseFields,
    // rcon: a port, or "auto" so the panel picks a free one (the stored spec only ever holds a number).
    ports: z
      .object({ game: port.optional(), extra: z.array(portMappingSchema).default([]), rcon: z.union([port, z.literal("auto")]).optional() })
      .superRefine(rconPortCheck)
      .prefault({}),
    // plan-6: a PATCH keeps it when merging with the stored spec (if it were missing, zod would discard it
    // and the server would be recreated over <DATA_ROOT>/<slug>/data, empty).
    dataPath: dataPathSchema.optional(),
  })
  .superRefine(specChecks)
  .superRefine(dataPathCheck);

export type Spec = z.infer<typeof specSchema>;
export type SpecInput = z.infer<typeof specInputSchema>;

export function defaultSpecInput(): SpecInput {
  return specInputSchema.parse({});
}

export const serverCreateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
  spec: specInputSchema.prefault({}),
});
export type ServerCreateInput = z.infer<typeof serverCreateSchema>;

export const serverPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  /** First-level merge over the stored spec (see mergeSpecPatch). */
  spec: specPatchSchema.optional(),
});
export const powerActionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) });
export type PowerActionName = z.infer<typeof powerActionSchema>["action"];

// ── plan-2 ──
// ── plan-3 ──
/**
 * Template spec: the server one without `ports` or `rconPassword`. When parsing, zod discards those
 * keys (and any other unknown one), so saving a server spec as a template
 * never drags along ports or secrets. (Not `.omit()`: zod 4 rejects it with refinements.)
 */
export const templateSpecSchema = z.object({ ...baseFields }).superRefine(specChecks);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

/** Can the PATCH delete the key with `null`? Only optional sections (no default value) and unknown ones (no-op). */
function nullableInPatch(key: string): boolean {
  const field = (specInputSchema.shape as Record<string, z.ZodType | undefined>)[key];
  if (!field) return true;
  const r = field.safeParse(undefined);
  return r.success && r.data === undefined;
}

/**
 * Spec PATCH (server or template): `null` on a required key or one with a default value
 * (type, version, memory, ports, properties…) would silently reset it (a FABRIC would become PAPER and
 * be recreated over a world with mods). Returns the 400 message or null if the PATCH is valid.
 */
export function specPatchNullError(patch: SpecPatch): string | null {
  const key = Object.keys(patch).find((k) => patch[k] === null && !nullableInPatch(k));
  return key === undefined ? null : `The spec key “${key}” is required: it cannot be deleted with null (send its value)`;
}
// ── plan-4 ──
// ── plan-5 ──
// ── plan-6 ──
// ── plan-7 ──
// ── plan-8 ──
export * from "./router.js";
// ── plan-9 ──
export * from "./events.js";
export * from "./settings.js";
