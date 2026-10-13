import { z } from "zod";
import { templateSpecSchema, type TemplateSpec } from "./spec.js";
import { specPatchSchema } from "./spec-patch.js";

const templateName = z.string().trim().min(1, "The name is required").max(60, "Maximum 60 characters");
const templateDescription = z.string().trim().max(500, "Maximum 500 characters");

/** Create template: from a spec (template editor) or from a server ("Save as template"). */
export const templateCreateSchema = z
  .object({
    name: templateName,
    description: templateDescription.default(""),
    spec: specPatchSchema.optional(),
    fromServerId: z.string().min(1).optional(),
  })
  .refine((t) => (t.spec === undefined) !== (t.fromServerId === undefined), { message: "Specify a spec or a source server (only one)" });
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;

/** Template PATCH: `spec` with the same merge semantics as the server PATCH. */
export const templatePatchSchema = z.object({
  name: templateName.optional(),
  description: templateDescription.optional(),
  spec: specPatchSchema.optional(),
});

/** Create a server from a template: the panel fills in the port (if not given) and rconPassword. */
export const templateInstantiateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
});
export type TemplateInstantiateInput = z.infer<typeof templateInstantiateSchema>;

/** Strips ports, rconPassword, the router and any key foreign to the template. Throws ZodError if it does not validate. */
export function specToTemplate(spec: Record<string, unknown>): TemplateSpec {
  // plan-8: the router hostname belongs to a specific server (unique per node): it does not travel in templates.
  const { router: _router, ...rest } = spec;
  return templateSpecSchema.parse(rest);
}

/** "Name (copy)", "Name (copy 2)"… without exceeding 60 characters. */
export function copyName(name: string, n: number): string {
  const suffix = n <= 1 ? " (copy)" : ` (copy ${n})`;
  return name.slice(0, 60 - suffix.length).trimEnd() + suffix;
}
