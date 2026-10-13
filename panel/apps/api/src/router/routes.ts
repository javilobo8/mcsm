import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { RouterRepo } from "./repo.js";
import { RouterService } from "./service.js";

/** Decorates `app.routerService` at the root and registers the encapsulated routes of each node's router. */
export const routerRoutes = fp(async function routerRoutes(root: FastifyInstance) {
  const svc = new RouterService(root, new RouterRepo(root.db));
  root.decorate("routerService", svc);
  svc.start();
  await root.register(routerRoutesInner);
});

async function routerRoutesInner(app: FastifyInstance) {
  const svc = app.routerService;
  // PUT (not POST): the Plan 7 migration guard blocks the POST /api/nodes/:id/… of a node that is migrating.
  app.get<{ Params: { id: string } }>("/api/nodes/:id/router", async (req) => svc.get(req.params.id));
  app.put<{ Params: { id: string } }>("/api/nodes/:id/router", async (req) => svc.put(req.params.id, req.body));
}

declare module "fastify" {
  interface FastifyInstance { routerService: RouterService }
}
