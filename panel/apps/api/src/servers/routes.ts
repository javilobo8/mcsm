import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { powerActionSchema, serverCreateSchema, serverPatchSchema } from "@mcsm/shared";
import { HttpError, ServersService } from "./service.js";
import { toServerDto } from "./repo.js";

/** Decora el servicio en la raíz y registra las rutas encapsuladas (el errorHandler solo afecta a /api/servers). */
export const serverRoutes = fp(async function serverRoutes(root: FastifyInstance) {
  const svc = new ServersService(root);
  root.decorate("serversService", svc);
  await root.register(serverRoutesInner);
});

async function serverRoutesInner(app: FastifyInstance) {
  const svc = app.serversService;

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Datos inválidos" });
    const status = (err as FastifyError).statusCode;
    if (status === undefined || status >= 500) {
      app.log.error(err);
      return reply.code(500).send({ error: "Error interno" });
    }
    return reply.code(status).send({ error: err.message });
  });

  app.get("/api/servers", async () => app.servers.list().map((r) => toServerDto(r)));

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (req) => {
    const row = app.servers.get(req.params.id);
    if (!row) throw new HttpError(404, "Servidor no encontrado");
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
