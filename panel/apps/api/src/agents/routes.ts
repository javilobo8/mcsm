import type { FastifyInstance } from "fastify";
import { hashToken } from "../lib/tokens.js";

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url !== "/agent/ws") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !app.nodes.findByTokenHash(hashToken(token))) return reply.code(401).send({ error: "token inválido" });
  });

  app.get("/agent/ws", { websocket: true }, (socket, req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const node = token ? app.nodes.findByTokenHash(hashToken(token)) : null;
    if (!node) {
      socket.close(4401, "token inválido");
      return;
    }
    req.log.info({ nodeId: node.id, name: node.name }, "agente conectado");
    app.agents.attach(node.id, socket);
  });
}
