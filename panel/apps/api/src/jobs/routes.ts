import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { JobsRepo } from "./repo.js";
import { JobService } from "./service.js";

const PURGE_AFTER_DAYS = 30;
const PURGE_EVERY_MS = 60 * 60 * 1000;

const JOB_STATE = z.enum(["queued", "running", "ok", "failed", "cancelled"]);

const listQuery = z.object({
  serverId: z.string().min(1).optional(),
  // Un estado o una lista separada por comas (`queued,running`).
  status: z.string().transform((s) => s.split(",")).pipe(z.array(JOB_STATE).min(1).max(5)).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().min(1).optional(),
});

/** Decora `app.jobs` en la raíz y registra las rutas encapsuladas de /api/jobs. */
export const jobRoutes = fp(async function jobRoutes(root: FastifyInstance) {
  const svc = new JobService(new JobsRepo(root.db), root.events);
  root.decorate("jobs", svc);
  const purge = () => svc.purgeFinishedBefore(new Date(Date.now() - PURGE_AFTER_DAYS * 86_400_000).toISOString());
  let timer: NodeJS.Timeout | undefined;
  root.addHook("onReady", async () => {
    const n = svc.interruptStale();
    if (n > 0) root.log.warn({ count: n }, "jobs interrumpidos por el reinicio del panel");
    purge();
    timer = setInterval(purge, PURGE_EVERY_MS);
    timer.unref();
  });
  root.addHook("onClose", async () => { if (timer) clearInterval(timer); });
  await root.register(jobRoutesInner);
});

async function jobRoutesInner(app: FastifyInstance) {
  app.get("/api/jobs", async (req) => app.jobs.list(listQuery.parse(req.query)));

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = app.jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: "Job no encontrado" });
    return job;
  });
}

declare module "fastify" {
  interface FastifyInstance { jobs: JobService }
}
