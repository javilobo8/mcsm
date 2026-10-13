import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  copyName, formatZodError, mergeSpecPatch, serverCreateSchema, specPatchNullError, specSizeError, specToTemplate, templateCreateSchema,
  templateInstantiateSchema, templatePatchSchema, type Spec, type TemplateSpec,
} from "@mcsm/shared";
import { HttpError } from "../servers/service.js";
import { toTemplateDto, type TemplateRow } from "./repo.js";

/** Validates a template spec; errors come out as 400 with the field path. Same 64 KiB cap as a server. */
function toTemplateSpec(raw: Record<string, unknown>): TemplateSpec {
  let spec: TemplateSpec;
  try {
    spec = specToTemplate(raw);
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, formatZodError(e));
    throw e;
  }
  const tooBig = specSizeError(spec);
  if (tooBig) throw new HttpError(400, tooBig);
  return spec;
}

export async function templateRoutes(app: FastifyInstance) {
  const repo = app.templates;

  const requireTemplate = (id: string): TemplateRow => {
    const row = repo.get(id);
    if (!row) throw new HttpError(404, "Template not found");
    return row;
  };
  const ensureFreeName = (name: string, selfId?: string) => {
    const other = repo.getByName(name);
    if (other && other.id !== selfId) throw new HttpError(409, `A template named “${name}” already exists`);
  };

  app.get("/api/templates", async () => repo.list().map(toTemplateDto));

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (req) => toTemplateDto(requireTemplate(req.params.id)));

  app.post("/api/templates", async (req, reply) => {
    const input = templateCreateSchema.parse(req.body);
    ensureFreeName(input.name);
    let spec: TemplateSpec;
    let sourceServerId: string | null = null;
    if (input.fromServerId) {
      const server = app.servers.get(input.fromServerId);
      if (!server) throw new HttpError(404, "Server not found");
      spec = toTemplateSpec(JSON.parse(server.spec) as Spec);
      sourceServerId = server.id;
    } else {
      spec = toTemplateSpec(input.spec ?? {});
    }
    const row = repo.create({ name: input.name, description: input.description, spec, sourceServerId });
    return reply.code(201).send(toTemplateDto(row));
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const row = requireTemplate(req.params.id);
    const input = templatePatchSchema.parse(req.body);
    const nullErr = input.spec ? specPatchNullError(input.spec) : null;
    if (nullErr) throw new HttpError(400, nullErr);
    const name = input.name ?? row.name;
    ensureFreeName(name, row.id);
    const spec = input.spec ? toTemplateSpec(mergeSpecPatch(JSON.parse(row.spec) as Record<string, unknown>, input.spec)) : (JSON.parse(row.spec) as TemplateSpec);
    return toTemplateDto(repo.update(row.id, { name, description: input.description ?? row.description, spec }));
  });

  app.post<{ Params: { id: string } }>("/api/templates/:id/duplicate", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    let n = 1;
    while (repo.getByName(copyName(row.name, n))) n++;
    const copy = repo.create({ name: copyName(row.name, n), description: row.description, spec: JSON.parse(row.spec) as TemplateSpec, sourceServerId: row.source_server_id });
    return reply.code(201).send(toTemplateDto(copy));
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!repo.delete(req.params.id)) throw new HttpError(404, "Template not found");
    return reply.code(204).send();
  });

  /** Creates a server identical to the template except name, ports and rconPassword (set by the panel). */
  app.post<{ Params: { id: string } }>("/api/templates/:id/servers", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    const input = templateInstantiateSchema.parse(req.body);
    const spec = JSON.parse(row.spec) as TemplateSpec;
    const parsed = serverCreateSchema.safeParse({
      nodeId: input.nodeId, name: input.name, slug: input.slug, desiredState: input.desiredState,
      spec: { ...spec, ports: input.port ? { game: input.port, extra: [] } : { extra: [] } },
    });
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return reply.code(201).send(await app.serversService.create(parsed.data));
  });
}
