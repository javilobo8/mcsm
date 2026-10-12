import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { HttpError } from "../servers/service.js";
import { BackupsRepo } from "./repo.js";
import { BackupService } from "./service.js";

/** Decora `app.backupsService` en la raíz y registra las rutas encapsuladas de copias. */
export const backupRoutes = fp(async function backupRoutes(root: FastifyInstance) {
  const svc = new BackupService(root, new BackupsRepo(root.db));
  root.decorate("backupsService", svc);
  svc.start();
  await root.register(backupRoutesInner);
});

async function backupRoutesInner(app: FastifyInstance) {
  const svc = app.backupsService;

  app.get<{ Params: { id: string } }>("/api/servers/:id/backups", async (req) => svc.list(req.params.id));

  // Acciones del usuario
  app.post<{ Params: { id: string } }>("/api/servers/:id/backups", async (req, reply) =>
    reply.code(202).send(await svc.createNow(req.params.id, req.headers["idempotency-key"]?.toString())));

  app.post<{ Params: { id: string; backupId: string } }>("/api/servers/:id/backups/:backupId/restore", async (req, reply) =>
    reply.code(202).send(await svc.restore(req.params.id, req.params.backupId)));

  app.delete<{ Params: { id: string; backupId: string } }>("/api/servers/:id/backups/:backupId", async (req, reply) => {
    await svc.remove(req.params.id, req.params.backupId);
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string } }>("/api/servers/:id/backups/schedule", async (req) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "Falta la programación de copias");
    return svc.updateSchedule(req.params.id, req.body);
  });
}

declare module "fastify" {
  interface FastifyInstance { backupsService: BackupService }
}
