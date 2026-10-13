import type { FastifyInstance } from "fastify";
import { hashToken } from "../lib/tokens.js";
import { toNodeDto } from "../nodes/repo.js";

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
    const hash = token ? hashToken(token) : "";
    const node = hash ? app.nodes.findByTokenHash(hash) : null;
    if (!node) {
      socket.close(4401, "token inválido");
      return;
    }
    // plan-9: primera conexión con el token de una rotación: pasa a ser el del nodo y el anterior deja de valer.
    if (node.pending_token_hash === hash && app.nodes.promotePendingToken(node.id)) {
      req.log.info({ nodeId: node.id }, "el agente usa ya su token nuevo");
      app.eventsService.record({ nodeId: node.id, serverId: null, level: "info", kind: "token_rotated",
        message: `El nodo «${node.name}» se ha conectado con su token nuevo; el anterior ya no vale` });
      app.events.emit("node", toNodeDto(app.nodes.get(node.id)!));
    }
    req.log.info({ nodeId: node.id, name: node.name }, "agente conectado");
    app.agents.attach(node.id, socket);
  });
}
