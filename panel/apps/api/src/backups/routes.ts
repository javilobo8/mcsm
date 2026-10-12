import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
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
}

declare module "fastify" {
  interface FastifyInstance { backupsService: BackupService }
}
