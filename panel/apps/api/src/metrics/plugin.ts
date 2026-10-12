import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { metricRangeSchema } from "@mcsm/shared";
import { MetricsRepo } from "./repo.js";
import { MetricsService } from "./service.js";

/**
 * Decora `app.metrics` en la raíz (lo usa el despacho de mensajes del agente), arranca la purga
 * horaria y registra las rutas. Necesita `app.db`, `app.servers` y `app.events` ya decorados.
 */
export const metricsPlugin = fp(async function metricsPlugin(app: FastifyInstance) {
  const svc = new MetricsService({
    repo: new MetricsRepo(app.db),
    serverIdsOf: (nodeId) => new Set(app.servers.list(nodeId).map((r) => r.id)),
    events: app.events,
    log: app.log,
  });
  app.decorate("metrics", svc);
  app.addHook("onReady", async () => svc.start());
  app.addHook("onClose", async () => svc.stop());
  await app.register(metricsRoutes);
});

const query = z.object({ range: metricRangeSchema.default("1h") });

async function metricsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/servers/:id/metrics", async (req, reply) => {
    if (!app.servers.get(req.params.id)) return reply.code(404).send({ error: "Servidor no encontrado" });
    const q = query.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? "Rango inválido" });
    return app.metrics.series("server", req.params.id, q.data.range);
  });

  app.get<{ Params: { id: string } }>("/api/nodes/:id/metrics", async (req, reply) => {
    if (!app.nodes.get(req.params.id)) return reply.code(404).send({ error: "Nodo no encontrado" });
    const q = query.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? "Rango inválido" });
    return app.metrics.series("node", req.params.id, q.data.range);
  });
}

declare module "fastify" {
  interface FastifyInstance { metrics: MetricsService }
}
