import { z } from "zod";
import { canonicalJson, specPatchSchema } from "./spec-patch.js";
import { specInputSchema, type SpecInput } from "./spec.js";

/** Origen de un servidor importado (columna servers.imported_from, spec §4). */
export interface ImportedFrom {
  containerId: string;
  containerName: string;
  /** Versión de la spec con la que se adoptó: hasta superarla, el agente sigue el contenedor original. */
  specVersion: number;
  importedAt: string;
  composeProject: string;
  composeService: string;
}

/** Candidato a importar tal y como lo ve el navegador: nunca lleva RCON_PASSWORD ni CF_API_KEY. */
export interface ImportCandidateDto {
  containerId: string;
  containerName: string;
  image: string;
  state: string;
  composeProject: string;
  composeService: string;
  /** Por qué no se puede importar (vacío = se puede). */
  blockers: string[];
  /** Lo que no se conserva o cambia al recrear, y avisos de uso. */
  warnings: string[];
  /** Variables del contenedor que no se muestran porque son secretos. */
  hiddenEnv: string[];
  proposal: {
    name: string;
    slug: string;
    /** Los datos están en <DATA_ROOT>/<slug>/data: cambiar el slug apuntaría a otra carpeta. */
    slugLocked: boolean;
    desiredState: "running" | "stopped";
    /** Spec deducida, sin rconPassword ni dataPath. */
    spec: SpecInput;
    /** Primer error de validación de la spec deducida; con él solo cabe corregirla y «Adoptar y aplicar». */
    specError: string | null;
    /** Carpeta de datos fuera de DATA_ROOT, o null si están en <DATA_ROOT>/<slug>/data. */
    dataPath: string | null;
  };
}

export const DOCKER_ID_RE = /^[0-9a-f]{64}$/;

/** POST /api/nodes/:id/import. `spec` es la SpecInput revisada; el panel ignora dataPath (lo saca del contenedor). */
export const importAdoptSchema = z.object({
  containerId: z.string().regex(DOCKER_ID_RE, "Id de contenedor inválido"),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  spec: specPatchSchema,
  /** false: adopción en caliente (exige la propuesta sin cambios); true: adopta y recrea enseguida con la spec revisada. */
  applyNow: z.boolean().default(false),
});
export type ImportAdoptInput = z.infer<typeof importAdoptSchema>;

function normalized(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const { dataPath: _d, rconPassword: _r, ...rest } = v as Record<string, unknown>;
  const r = specInputSchema.safeParse(rest);
  return r.success ? r.data : rest;
}

/** ¿Misma configuración? Compara tras normalizar con zod, sin dataPath ni rconPassword (no los edita el usuario). */
export function sameSpecInput(a: unknown, b: unknown): boolean {
  return canonicalJson(normalized(a)) === canonicalJson(normalized(b));
}
