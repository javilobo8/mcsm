import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { contentDisposition } from "../files/disposition.js";
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

  app.get<{ Params: { id: string; backupId: string } }>("/api/servers/:id/backups/:backupId/download", {
    exposeHeadRoute: false, // un HEAD pediría al agente subir la copia entera
    // Un fallo antes del primer byte se responde en JSON, sin las cabeceras de la descarga.
    onError: async (_req, reply) => {
      for (const h of ["content-type", "content-length", "content-disposition"]) {
        reply.removeHeader(h);
        if (!reply.raw.headersSent) reply.raw.removeHeader(h);
      }
    },
  }, async (req, reply) => {
    const ctrl = new AbortController();
    reply.raw.once("close", () => { if (!reply.raw.writableFinished) ctrl.abort(); });
    const dl = await svc.download(req.params.id, req.params.backupId, ctrl.signal);
    dl.done.catch((e) => req.log.info({ err: e }, "el agente no confirmó la subida de la copia"));
    reply.header("content-type", "application/octet-stream");
    reply.header("cache-control", "no-store");
    reply.header("content-disposition", contentDisposition(dl.filename));
    if (dl.size !== null) reply.header("content-length", String(dl.size));
    return reply.send(dl.stream);
  });

  app.patch<{ Params: { id: string } }>("/api/servers/:id/backups/schedule", async (req) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "Falta la programación de copias");
    return svc.updateSchedule(req.params.id, req.body as Record<string, unknown>);
  });
}

declare module "fastify" {
  interface FastifyInstance { backupsService: BackupService }
}
