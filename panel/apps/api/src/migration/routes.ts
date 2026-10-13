import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { MigrationService } from "./service.js";

/** Decorates `app.migrationService` at the root and registers the encapsulated migration routes. */
export const migrationRoutes = fp(async function migrationRoutes(root: FastifyInstance) {
  const svc = new MigrationService(root);
  root.decorate("migrationService", svc);
  svc.start();
  // After jobs.interruptStale (registered earlier): the job is left “interrupted” and the migration starts rolling back.
  root.addHook("onReady", async () => { await svc.recover(); });
  root.addHook("onClose", async () => { svc.close(); });
  await root.register(async function migrationRoutesInner(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>("/api/servers/:id/migration", async (req) => svc.latest(req.params.id));
    app.get<{ Params: { id: string } }>("/api/servers/:id/migration/proposal", async (req) => svc.proposal(req.params.id, req.query));
    app.post<{ Params: { id: string } }>("/api/servers/:id/migration", async (req, reply) => reply.code(202).send(svc.begin(req.params.id, req.body)));
    // Manual closing of a stuck migration (rolling back or pending removal): stops retrying what is pending.
    app.post<{ Params: { id: string } }>("/api/servers/:id/migration/close", async (req) => svc.closeManually(req.params.id));
  });
}, { name: "migration" });

declare module "fastify" {
  interface FastifyInstance { migrationService: MigrationService }
}
