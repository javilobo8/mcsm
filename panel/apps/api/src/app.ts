import { EventEmitter } from "node:events";
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

export interface AppOptions { db: Db; logger?: boolean; config?: Partial<Config> }

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const cfg: Config = { ...config, ...opts.config };
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate("db", opts.db);
  app.decorate("config", cfg);
  app.decorate("nodes", new NodesRepo(opts.db));

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(nodeRoutes);
  app.decorate("events", new EventEmitter());
  app.decorate("agents", new AgentHub());
  app.decorate("servers", new ServersRepo(opts.db));
  await app.register(agentRoutes);
  new AgentService(app).start();
  app.addHook("onReady", async () => app.nodes.markAllOffline());
  // Task 14: await app.register(serverRoutes);
  // Task 15: await app.register(realtimeRoutes);
  // Task 19: estáticos de la web si cfg.webDist
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
