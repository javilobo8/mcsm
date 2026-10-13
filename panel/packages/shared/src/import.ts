import { z } from "zod";
import { canonicalJson, specPatchSchema } from "./spec-patch.js";
import { specInputSchema, type SpecInput } from "./spec.js";

/** Origin of an imported server (servers.imported_from column, spec §4). */
export interface ImportedFrom {
  containerId: string;
  containerName: string;
  /** Spec version with which it was adopted: until it is exceeded, the agent follows the original container. */
  specVersion: number;
  importedAt: string;
  composeProject: string;
  composeService: string;
}

/** Import candidate as the browser sees it: it never carries RCON_PASSWORD or CF_API_KEY. */
export interface ImportCandidateDto {
  containerId: string;
  containerName: string;
  image: string;
  state: string;
  composeProject: string;
  composeService: string;
  /** Why it cannot be imported (empty = it can). */
  blockers: string[];
  /** What is not kept or changes on recreation, and usage warnings. */
  warnings: string[];
  /** Container variables that are not shown because they are secrets. */
  hiddenEnv: string[];
  proposal: {
    name: string;
    slug: string;
    /** The data is in <DATA_ROOT>/<slug>/data: changing the slug would point to another folder. */
    slugLocked: boolean;
    desiredState: "running" | "stopped";
    /** Deduced spec, without rconPassword or dataPath. */
    spec: SpecInput;
    /** First validation error of the deduced spec; with it the only option is to fix it and “Adopt and apply”. */
    specError: string | null;
    /** Data folder outside DATA_ROOT, or null if it is in <DATA_ROOT>/<slug>/data. */
    dataPath: string | null;
  };
}

export const DOCKER_ID_RE = /^[0-9a-f]{64}$/;

/** POST /api/nodes/:id/import. `spec` is the reviewed SpecInput; the panel ignores dataPath (it takes it from the container). */
export const importAdoptSchema = z.object({
  containerId: z.string().regex(DOCKER_ID_RE, "Invalid container id"),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  spec: specPatchSchema,
  /** false: hot adoption (requires the proposal unchanged); true: adopts and recreates right away with the reviewed spec. */
  applyNow: z.boolean().default(false),
});
export type ImportAdoptInput = z.infer<typeof importAdoptSchema>;

function normalized(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const { dataPath: _d, rconPassword: _r, ...rest } = v as Record<string, unknown>;
  const r = specInputSchema.safeParse(rest);
  return r.success ? r.data : rest;
}

/** Same configuration? Compares after normalizing with zod, without dataPath or rconPassword (the user does not edit them). */
export function sameSpecInput(a: unknown, b: unknown): boolean {
  return canonicalJson(normalized(a)) === canonicalJson(normalized(b));
}
