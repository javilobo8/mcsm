import { z } from "zod";

export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
]);

const memory = z.string().regex(/^[1-9]\d*[MmGg]$/, "Formato de memoria inválido (ej. 4G, 512M; sin ceros)");
const port = z.number().int().min(1).max(65535);
const RCON_PORT = 25575;
const RESERVED_PROPS = new Set(["server-port", "enable-rcon", "rcon.port", "rcon.password"]);

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

const envSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Nombre de variable inválido"), z.string())
  .refine((env) => !Object.keys(env).some((k) => RESERVED_ENV.has(k)), {
    message: "Contiene una variable reservada (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES)",
  });

const resourcesSchema = z.object({
  cpus: z.number().min(0).default(0),
  memLimit: z.union([z.literal(""), memory]).default(""),
});

const baseFields = {
  imageTag: z.string().min(1).default("latest"),
  type: z.string().min(1).default("PAPER"),
  version: z.string().min(1).default("LATEST"),
  memory: memory.default("2G"),
  properties: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "Nombre de propiedad inválido").refine((k) => !RESERVED_PROPS.has(k), {
        message: "La propiedad es reservada (la gestiona el agente)",
      }),
      z.string().refine((v) => !/[\r\n]/.test(v), { message: "El valor de la propiedad no puede contener saltos de línea" }),
    )
    .default({}),
  env: envSchema.default({}),
  resources: resourcesSchema.prefault({}),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
};

function memLimitCheck(s: { memory: string; resources: { memLimit: string } }, ctx: z.RefinementCtx) {
  if (s.resources.memLimit && memoryToBytes(s.resources.memLimit) < memoryToBytes(s.memory)) {
    ctx.addIssue({ code: "custom", path: ["resources", "memLimit"], message: "memLimit no puede ser menor que memory" });
  }
}

/** Spec completa, tal y como se persiste y se envía al agente. */
export const specSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port, extra: z.array(portMappingSchema).default([]) }),
    rconPassword: z.string().min(8),
  })
  .superRefine(memLimitCheck);

/** Lo que envía la UI al crear/editar: el panel añade puerto y rconPassword. */
export const specInputSchema = z
  .object({
    ...baseFields,
    ports: z.object({ game: port.optional(), extra: z.array(portMappingSchema).default([]) }).prefault({}),
  })
  .superRefine(memLimitCheck);

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
  spec: specInputSchema.optional(),
});
export const powerActionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill"]) });
export type PowerActionName = z.infer<typeof powerActionSchema>["action"];
