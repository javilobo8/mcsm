import { z } from "zod";
import "./zod-locale.js";
import { specPatchSchema, type SpecPatch } from "./spec-patch.js";
import { contentCheck, contentFields } from "./spec-content.js";
import { limitsCheck } from "./spec-limits.js";
import { backupsSchema } from "./backups.js";

export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
  "CF_API_KEY",
]);

export const MEMORY_RE = /^[1-9]\d*[MmGg]$/;
const memory = z.string().regex(MEMORY_RE, "Formato de memoria inválido (ej. 4G, 512M; sin ceros)");
/** Etiqueta de la imagen itzg (gramática de tag de Docker, sin digest). Misma regex que el agente. */
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
  message: "El puerto extra no puede publicar RCON (25575)",
});

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envSchema = z
  .record(z.string().regex(ENV_KEY_RE, "Nombre de variable inválido"), z.string())
  .refine((env) => !Object.keys(env).some((k) => RESERVED_ENV.has(k)), {
    message: "Contiene una variable reservada (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES, CF_API_KEY)",
  });

const resourcesSchema = z.object({
  cpus: z.number().min(0).default(0),
  memLimit: z.union([z.literal(""), memory]).default(""),
});

const baseFields = {
  imageTag: z.string().regex(IMAGE_TAG_RE, "Etiqueta de imagen inválida (letras, números, . _ -; empieza por letra o número; máx. 128)").default("latest"),
  type: z.string().min(1).default("PAPER"),
  version: z.string().min(1).default("LATEST"),
  memory: memory.default("2G"),
  properties: z
    .record(
      z.string().regex(PROPERTY_KEY_RE, "Nombre de propiedad inválido").refine((k) => !RESERVED_PROPS.has(k), {
        message: "La propiedad es reservada (la gestiona el agente)",
      }),
      z.string().refine((v) => !/[\r\n]/.test(v), { message: "El valor de la propiedad no puede contener saltos de línea" }),
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
  // ── plan-9 ──
};

function memLimitCheck(s: { memory: string; resources: { memLimit: string } }, ctx: z.RefinementCtx) {
  if (s.resources.memLimit && memoryToBytes(s.resources.memLimit) < memoryToBytes(s.memory)) {
    ctx.addIssue({ code: "custom", path: ["resources", "memLimit"], message: "memLimit no puede ser menor que memory" });
  }
}

/** Validaciones de objeto completo: memoria y, debajo de las anclas, las de cada plan. */
function specChecks(s: Parameters<typeof memLimitCheck>[0] & Parameters<typeof contentCheck>[0] & Parameters<typeof limitsCheck>[0], ctx: z.RefinementCtx) {
  memLimitCheck(s, ctx);
  // ── plan-3 ──
  contentCheck(s, ctx);
  limitsCheck(s, ctx);
}

/** Spec completa, tal y como se persiste y se envía al agente. */
export const specSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port, extra: z.array(portMappingSchema).default([]) }),
    rconPassword: z.string().min(8),
  })
  .superRefine(specChecks);

/** Lo que envía la UI al crear/editar: el panel añade puerto y rconPassword. */
export const specInputSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port.optional(), extra: z.array(portMappingSchema).default([]) }).prefault({}),
  })
  .superRefine(specChecks);

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
  /** Merge de primer nivel sobre la spec guardada (ver mergeSpecPatch). */
  spec: specPatchSchema.optional(),
});
export const powerActionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) });
export type PowerActionName = z.infer<typeof powerActionSchema>["action"];

// ── plan-2 ──
// ── plan-3 ──
/**
 * Spec de plantilla: la de servidor sin `ports` ni `rconPassword`. Al parsear, zod descarta esas
 * claves (y cualquier otra desconocida), así que guardar una spec de servidor como plantilla
 * nunca arrastra puertos ni secretos. (No `.omit()`: zod 4 lo rechaza con refinamientos.)
 */
export const templateSpecSchema = z.object({ ...baseFields }).superRefine(specChecks);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;

/** ¿Puede el PATCH borrar la clave con `null`? Solo las secciones opcionales (sin valor por defecto) y las desconocidas (no-op). */
function nullableInPatch(key: string): boolean {
  const field = (specInputSchema.shape as Record<string, z.ZodType | undefined>)[key];
  if (!field) return true;
  const r = field.safeParse(undefined);
  return r.success && r.data === undefined;
}

/**
 * PATCH de spec (servidor o plantilla): `null` en una clave obligatoria o con valor por defecto
 * (type, version, memory, ports, properties…) la resetearía en silencio (un FABRIC pasaría a PAPER y
 * se recrearía sobre un mundo con mods). Devuelve el mensaje del 400 o null si el PATCH es válido.
 */
export function specPatchNullError(patch: SpecPatch): string | null {
  const key = Object.keys(patch).find((k) => patch[k] === null && !nullableInPatch(k));
  return key === undefined ? null : `La clave «${key}» de la spec es obligatoria: no se puede borrar con null (envía su valor)`;
}
// ── plan-4 ──
// ── plan-5 ──
// ── plan-6 ──
// ── plan-7 ──
// ── plan-8 ──
// ── plan-9 ──
