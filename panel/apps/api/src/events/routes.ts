import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { eventsQuerySchema, formatZodError } from "@mcsm/shared";
import { HttpError } from "../lib/http.js";
import { EventsRepo } from "./repo.js";
import { EventsService } from "./service.js";

/** Decorates `app.eventsService` at the root (used by agent dispatch and token rotation) and registers the routes. */
export const eventsRoutes = fp(async function eventsRoutes(root: FastifyInstance) {
  const svc = new EventsService(root, new EventsRepo(root.db));
  root.decorate("eventsService", svc);
  root.addHook("onReady", async () => svc.start());
  root.addHook("onClose", async () => svc.stop());
  await root.register(async (app) => {
    app.get("/api/events", async (req) => {
      const q = eventsQuerySchema.safeParse(req.query ?? {});
      if (!q.success) throw new HttpError(400, formatZodError(q.error));
      return svc.list(q.data);
    });
  });
});

declare module "fastify" {
  interface FastifyInstance { eventsService: EventsService }
}
