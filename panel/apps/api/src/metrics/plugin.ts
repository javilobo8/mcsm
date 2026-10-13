import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { metricRangeSchema } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { MetricsRepo } from "./repo.js";
import { MetricsService } from "./service.js";

/**
 * Decorates `app.metrics` at the root (used by the agent message dispatch), starts the hourly
 * purge and registers the routes. Needs `app.db`, `app.servers` and `app.events` already decorated.
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
  app.get<{ Params: { id: string } }>("/api/servers/:id/metrics", async (req) => {
    if (!app.servers.get(req.params.id)) throw new HttpError(404, "Server not found");
    const q = query.safeParse(req.query ?? {});
    if (!q.success) throw new HttpError(400, q.error.issues[0]?.message ?? "Invalid range");
    return app.metrics.series("server", req.params.id, q.data.range);
  });

  app.get<{ Params: { id: string } }>("/api/nodes/:id/metrics", async (req) => {
    if (!app.nodes.get(req.params.id)) throw new HttpError(404, "Node not found");
    const q = query.safeParse(req.query ?? {});
    if (!q.success) throw new HttpError(400, q.error.issues[0]?.message ?? "Invalid range");
    return app.metrics.series("node", req.params.id, q.data.range);
  });
}

declare module "fastify" {
  interface FastifyInstance { metrics: MetricsService }
}
