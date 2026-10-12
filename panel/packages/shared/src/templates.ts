import { z } from "zod";
import { templateSpecSchema, type TemplateSpec } from "./spec.js";
import { specPatchSchema } from "./spec-patch.js";

const templateName = z.string().trim().min(1, "El nombre es obligatorio").max(60, "Máximo 60 caracteres");
const templateDescription = z.string().trim().max(500, "Máximo 500 caracteres");

/** Crear plantilla: desde una spec (editor de plantillas) o desde un servidor ("Guardar como plantilla"). */
export const templateCreateSchema = z
  .object({
    name: templateName,
    description: templateDescription.default(""),
    spec: specPatchSchema.optional(),
    fromServerId: z.string().min(1).optional(),
  })
  .refine((t) => (t.spec === undefined) !== (t.fromServerId === undefined), { message: "Indica una spec o un servidor de origen (solo uno)" });
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;

/** PATCH de plantilla: `spec` con la misma semántica de merge que el PATCH de servidor. */
export const templatePatchSchema = z.object({
  name: templateName.optional(),
  description: templateDescription.optional(),
  spec: specPatchSchema.optional(),
});

/** Crear un servidor desde una plantilla: el panel rellena puerto (si no se da) y rconPassword. */
export const templateInstantiateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
});
export type TemplateInstantiateInput = z.infer<typeof templateInstantiateSchema>;

/** Quita puertos, rconPassword y cualquier clave ajena a la plantilla. Lanza ZodError si no valida. */
export function specToTemplate(spec: Record<string, unknown>): TemplateSpec {
  return templateSpecSchema.parse(spec);
}

/** "Nombre (copia)", "Nombre (copia 2)"… sin pasar de 60 caracteres. */
export function copyName(name: string, n: number): string {
  const suffix = n <= 1 ? " (copia)" : ` (copia ${n})`;
  return name.slice(0, 60 - suffix.length).trimEnd() + suffix;
}
