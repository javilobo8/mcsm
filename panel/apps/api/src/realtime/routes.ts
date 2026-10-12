import type { FastifyInstance } from "fastify";
import { BrowserHub } from "./hub.js";

/**
 * L2: un navegador siempre envía Origin en el upgrade de un WebSocket y los WS no pasan por
 * CORS; SameSite=Strict no frena a páginas same-site (mismo host, otro puerto). Se acepta un
 * Origin cuyo host (con puerto) sea el de la petición o el origen de PANEL_PUBLIC_URL. Sin
 * Origin la petición no viene de un navegador (CLI, tests) y se permite.
 */
export function originAllowed(origin: string | undefined, host: string, publicUrl: string): boolean {
  if (origin === undefined) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  if (o.host.toLowerCase() === host.toLowerCase()) return true;
  if (!publicUrl) return false;
  try { return o.origin === new URL(publicUrl).origin; } catch { return false; }
}

export async function realtimeRoutes(app: FastifyInstance) {
  const hub = new BrowserHub(app);
  app.decorate("browserHub", hub);
  app.addHook("onClose", async () => hub.dispose());
  // El hook de auth (Task 11) ya responde 401 en /ws sin sesión, antes del upgrade; este va después.
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url !== "/ws") return;
    if (!originAllowed(req.headers.origin, req.host, app.config.publicUrl)) {
      return reply.code(403).send({ error: "Origen no permitido" });
    }
  });
  app.get("/ws", { websocket: true }, (socket) => hub.add(socket));
}

declare module "fastify" {
  interface FastifyInstance { browserHub: BrowserHub }
}
