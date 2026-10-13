import type { FastifyInstance } from "fastify";
import { originAllowed } from "../lib/origin.js";
import { BrowserHub } from "./hub.js";

export async function realtimeRoutes(app: FastifyInstance) {
  const hub = new BrowserHub(app);
  app.decorate("browserHub", hub);
  app.addHook("onClose", async () => hub.dispose());
  // El hook de auth (Task 11) ya responde 401 en /ws sin sesión, antes del upgrade; este va después.
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url !== "/ws") return;
    if (!originAllowed(req.headers.origin, req.host, app.settings.publicUrl())) {
      return reply.code(403).send({ error: "Origen no permitido" });
    }
  });
  app.get("/ws", { websocket: true }, (socket, req) => hub.add(socket, req.sessionId));
}

declare module "fastify" {
  interface FastifyInstance { browserHub: BrowserHub }
}
