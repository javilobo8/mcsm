import type { FastifyInstance } from "fastify";
import { hashToken } from "../lib/tokens.js";
import { toNodeDto } from "../nodes/repo.js";

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url !== "/agent/ws") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !app.nodes.findByTokenHash(hashToken(token))) return reply.code(401).send({ error: "invalid token" });
  });

  app.get("/agent/ws", { websocket: true }, (socket, req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const hash = token ? hashToken(token) : "";
    const node = hash ? app.nodes.findByTokenHash(hash) : null;
    if (!node) {
      socket.close(4401, "invalid token");
      return;
    }
    // plan-9: first connection with a rotation's token: it becomes the node's token and the previous one stops being valid.
    if (node.pending_token_hash === hash && app.nodes.promotePendingToken(node.id)) {
      req.log.info({ nodeId: node.id }, "the agent now uses its new token");
      app.eventsService.record({ nodeId: node.id, serverId: null, level: "info", kind: "token_rotated",
        message: `Node “${node.name}” connected with its new token; the previous one is no longer valid` });
      app.events.emit("node", toNodeDto(app.nodes.get(node.id)!));
    }
    req.log.info({ nodeId: node.id, name: node.name }, "agent connected");
    app.agents.attach(node.id, socket);
  });
}
