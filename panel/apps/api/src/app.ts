import { EventEmitter } from "node:events";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db/db.js";
import { config, type Config } from "./config.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { nodeRoutes } from "./nodes/routes.js";
import { NodesRepo } from "./nodes/repo.js";
import { AgentHub } from "./agents/hub.js";
import { agentRoutes } from "./agents/routes.js";
import { AgentService } from "./agents/service.js";
import { ServersRepo } from "./servers/repo.js";
import { serverRoutes } from "./servers/routes.js";
import { realtimeRoutes } from "./realtime/routes.js";

export interface AppOptions { db: Db; logger?: boolean; config?: Partial<Config> }

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const cfg: Config = { ...config, ...opts.config };
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate("db", opts.db);
  app.decorate("config", cfg);
  app.decorate("nodes", new NodesRepo(opts.db));

  app.get("/api/health", async () => ({ ok: true }));

  // Antes que el guard de sesión: su hook onRequest debe correr primero para que un 401 en el
  // upgrade (/ws, /agent/ws) cierre el socket en vez de dejarlo colgado.
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(nodeRoutes);
  app.decorate("events", new EventEmitter());
  app.decorate("agents", new AgentHub({ log: app.log }));
  app.decorate("servers", new ServersRepo(opts.db));
  await app.register(agentRoutes);
  new AgentService(app).start();
  app.addHook("onReady", async () => app.nodes.markAllOffline());
  await app.register(serverRoutes);
  await app.register(realtimeRoutes);
  if (cfg.webDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    // El notFoundHandler no pasa por el guard de sesión (no hay ruta enrutada): solo debe servir
    // index.html, nunca datos, y solo para navegaciones GET/HEAD fuera de /api, /agent y /ws.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      const reserved = path.startsWith("/api/") || path.startsWith("/agent/") || path === "/ws";
      if (reserved || (req.method !== "GET" && req.method !== "HEAD")) {
        return reply.code(404).send({ error: "No encontrado" });
      }
      return reply.sendFile("index.html");
    });
  }
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    nodes: NodesRepo;
    events: EventEmitter;
    agents: AgentHub;
    servers: ServersRepo;
  }
}
