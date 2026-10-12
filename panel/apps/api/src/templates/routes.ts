import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  copyName, formatZodError, mergeSpecPatch, serverCreateSchema, specPatchNullError, specSizeError, specToTemplate, templateCreateSchema,
  templateInstantiateSchema, templatePatchSchema, type Spec, type TemplateSpec,
} from "@mcsm/shared";
import { HttpError } from "../servers/service.js";
import { toTemplateDto, type TemplateRow } from "./repo.js";

/** Valida una spec de plantilla; los errores salen como 400 con la ruta del campo. Mismo tope de 64 KiB que un servidor. */
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
    if (!row) throw new HttpError(404, "Plantilla no encontrada");
    return row;
  };
  const ensureFreeName = (name: string, selfId?: string) => {
    const other = repo.getByName(name);
    if (other && other.id !== selfId) throw new HttpError(409, `Ya existe una plantilla llamada «${name}»`);
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
      if (!server) throw new HttpError(404, "Servidor no encontrado");
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
    if (!repo.delete(req.params.id)) throw new HttpError(404, "Plantilla no encontrada");
    return reply.code(204).send();
  });

  /** Crea un servidor idéntico a la plantilla salvo nombre, puertos y rconPassword (los pone el panel). */
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
