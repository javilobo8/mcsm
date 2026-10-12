import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { MigrationService } from "./service.js";

/** Decora `app.migrationService` en la raíz y registra las rutas encapsuladas de la migración. */
export const migrationRoutes = fp(async function migrationRoutes(root: FastifyInstance) {
  const svc = new MigrationService(root);
  root.decorate("migrationService", svc);
  svc.start();
  // Tras jobs.interruptStale (registrado antes): el job queda «interrumpido» y la migración pasa a deshacerse.
  root.addHook("onReady", async () => { await svc.recover(); });
  root.addHook("onClose", async () => { svc.close(); });
  await root.register(async function migrationRoutesInner(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>("/api/servers/:id/migration", async (req) => svc.latest(req.params.id));
    app.get<{ Params: { id: string } }>("/api/servers/:id/migration/proposal", async (req) => svc.proposal(req.params.id, req.query));
    app.post<{ Params: { id: string } }>("/api/servers/:id/migration", async (req, reply) => reply.code(202).send(svc.begin(req.params.id, req.body)));
  });
}, { name: "migration" });

declare module "fastify" {
  interface FastifyInstance { migrationService: MigrationService }
}
