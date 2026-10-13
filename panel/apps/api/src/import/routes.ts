import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { importAdoptSchema } from "@mcsm/shared";
import { ImportService } from "./service.js";

/** Nodes → Import (spec §6.7, §8). Decorates the service at the root and registers the encapsulated routes. */
export const importRoutes = fp(async function importRoutes(root: FastifyInstance) {
  const svc = new ImportService(root);
  root.decorate("importService", svc);
  await root.register(async (app) => {
    app.get<{ Params: { id: string } }>("/api/nodes/:id/import/candidates", async (req) => svc.candidates(req.params.id));
    app.post<{ Params: { id: string } }>("/api/nodes/:id/import", async (req, reply) =>
      reply.code(201).send(await svc.adopt(req.params.id, importAdoptSchema.parse(req.body))));
  });
});

declare module "fastify" {
  interface FastifyInstance { importService: ImportService }
}
