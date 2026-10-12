import type { FastifyInstance } from "fastify";
import { BrowserHub } from "./hub.js";

export async function realtimeRoutes(app: FastifyInstance) {
  const hub = new BrowserHub(app);
  app.decorate("browserHub", hub);
  // El hook de auth (Task 11) ya responde 401 en /ws sin sesión, antes del upgrade.
  app.get("/ws", { websocket: true }, (socket) => hub.add(socket));
}

declare module "fastify" {
  interface FastifyInstance { browserHub: BrowserHub }
}
