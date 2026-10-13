import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { powerActionSchema, serverCreateSchema, serverPatchSchema } from "@mcsm/shared";
import { HttpError, ServersService } from "./service.js";
import { toServerDto } from "./repo.js";

/** Decorates the service at the root and registers the encapsulated routes. Errors are translated by the global handler (lib/http.ts). */
export const serverRoutes = fp(async function serverRoutes(root: FastifyInstance) {
  const svc = new ServersService(root);
  root.decorate("serversService", svc);
  await root.register(serverRoutesInner);
});

async function serverRoutesInner(app: FastifyInstance) {
  const svc = app.serversService;

  app.get("/api/servers", async () => app.servers.list().map((r) => toServerDto(r)));

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (req) => {
    const row = app.servers.get(req.params.id);
    if (!row) throw new HttpError(404, "Server not found");
    return toServerDto(row, { includeSecrets: true });
  });

  app.post("/api/servers", async (req, reply) => {
    const dto = await svc.create(serverCreateSchema.parse(req.body));
    return reply.code(201).send(dto);
  });

  app.patch<{ Params: { id: string } }>("/api/servers/:id", async (req) => svc.patch(req.params.id, serverPatchSchema.parse(req.body)));

  app.delete<{ Params: { id: string }; Querystring: { deleteData?: string } }>("/api/servers/:id", async (req, reply) => {
    await svc.remove(req.params.id, req.query.deleteData === "true");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/servers/:id/power", async (req) => svc.power(req.params.id, powerActionSchema.parse(req.body).action));

  app.post<{ Params: { id: string } }>("/api/servers/:id/command", async (req) => {
    const { command } = z.object({ command: z.string().trim().min(1).max(500) }).parse(req.body);
    return svc.command(req.params.id, command);
  });
}

declare module "fastify" {
  interface FastifyInstance { serversService: ServersService }
}
