import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { filePathSchema } from "@mcsm/shared";
import { FilesService } from "./service.js";

const pathQuery = z.object({ path: filePathSchema });
const writeBody = z.object({ path: filePathSchema, content: z.string({ error: "Falta el contenido" }) });
const renameBody = z.object({ from: filePathSchema, to: filePathSchema });

/** 2 MiB de texto pueden ocupar bastante más en JSON (escapes); el límite real lo aplica el servicio. */
const WRITE_BODY_LIMIT = 16 * 1024 * 1024;

/** Decora el servicio en la raíz y registra las rutas encapsuladas (errores: manejador global). */
export const fileRoutes = fp(async function fileRoutes(root: FastifyInstance) {
  root.decorate("filesService", new FilesService(root));
  await root.register(fileRoutesInner);
}, { name: "files" });

async function fileRoutesInner(app: FastifyInstance) {
  const svc = app.filesService;

  type P = { Params: { id: string } };

  app.get<P>("/api/servers/:id/files", async (req) => svc.list(req.params.id, pathQuery.parse(req.query).path));

  app.get<P>("/api/servers/:id/files/stat", async (req) => svc.stat(req.params.id, pathQuery.parse(req.query).path));

  app.get<P>("/api/servers/:id/files/content", async (req) => svc.read(req.params.id, pathQuery.parse(req.query).path));

  app.post<P>("/api/servers/:id/files/content", { bodyLimit: WRITE_BODY_LIMIT }, async (req, reply) => {
    const { path, content } = writeBody.parse(req.body);
    await svc.write(req.params.id, path, content);
    return reply.code(204).send();
  });

  app.post<P>("/api/servers/:id/files/mkdir", async (req, reply) => {
    await svc.mkdir(req.params.id, pathQuery.parse(req.body).path);
    return reply.code(204).send();
  });

  app.post<P>("/api/servers/:id/files/rename", async (req, reply) => {
    const { from, to } = renameBody.parse(req.body);
    await svc.rename(req.params.id, from, to);
    return reply.code(204).send();
  });

  app.delete<P>("/api/servers/:id/files", async (req, reply) => {
    await svc.remove(req.params.id, pathQuery.parse(req.query).path);
    return reply.code(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance { filesService: FilesService }
}
