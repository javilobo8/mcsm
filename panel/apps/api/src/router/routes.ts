import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { RouterRepo } from "./repo.js";
import { RouterService } from "./service.js";

/** Decora `app.routerService` en la raíz y registra las rutas encapsuladas del router de cada nodo. */
export const routerRoutes = fp(async function routerRoutes(root: FastifyInstance) {
  const svc = new RouterService(root, new RouterRepo(root.db));
  root.decorate("routerService", svc);
  svc.start();
  await root.register(routerRoutesInner);
});

async function routerRoutesInner(app: FastifyInstance) {
  const svc = app.routerService;
  // PUT (no POST): la guarda de migraciones del Plan 7 bloquea los POST /api/nodes/:id/… de un nodo en migración.
  app.get<{ Params: { id: string } }>("/api/nodes/:id/router", async (req) => svc.get(req.params.id));
  app.put<{ Params: { id: string } }>("/api/nodes/:id/router", async (req) => svc.put(req.params.id, req.body));
}

declare module "fastify" {
  interface FastifyInstance { routerService: RouterService }
}
