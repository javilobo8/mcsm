import type { FastifyInstance } from "fastify";
import { originAllowed } from "../lib/origin.js";
import { BrowserHub } from "./hub.js";

export async function realtimeRoutes(app: FastifyInstance) {
  const hub = new BrowserHub(app);
  app.decorate("browserHub", hub);
  app.addHook("onClose", async () => hub.dispose());
  // The auth hook (Task 11) already responds 401 on /ws without a session, before the upgrade; this one comes after.
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url !== "/ws") return;
    if (!originAllowed(req.headers.origin, req.host, app.settings.publicUrl())) {
      return reply.code(403).send({ error: "Origin not allowed" });
    }
  });
  app.get("/ws", { websocket: true }, (socket, req) => hub.add(socket, req.sessionId));
}

declare module "fastify" {
  interface FastifyInstance { browserHub: BrowserHub }
}
