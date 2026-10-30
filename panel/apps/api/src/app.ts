import { CurseForgeKeyRepo } from "./curseforge/repo.js";
import { curseforgeRoutes } from "./curseforge/routes.js";
import { EventEmitter } from "node:events";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Db } from "./db/db.js";
import { config, type Config } from "./config.js";
import { authPlugin } from "./auth/plugin.js";
import { authRoutes } from "./auth/routes.js";
import { nodeRoutes } from "./nodes/routes.js";
import { NodesRepo } from "./nodes/repo.js";
import { AgentHub } from "./agents/hub.js";
import { agentRoutes } from "./agents/routes.js";
import { transfersPlugin } from "./transfers/plugin.js";
import { fileRoutes } from "./files/routes.js";
import { AgentService } from "./agents/service.js";
import { ServersRepo } from "./servers/repo.js";
import { serverRoutes } from "./servers/routes.js";
import { realtimeRoutes } from "./realtime/routes.js";
import { metricsPlugin } from "./metrics/plugin.js";
import { TemplatesRepo } from "./templates/repo.js";
import { templateRoutes } from "./templates/routes.js";
import { errorHandler } from "./lib/http.js";
import { routerRoutes } from "./router/routes.js";
import { backupRoutes } from "./backups/routes.js";
import { jobRoutes } from "./jobs/routes.js";
import { eventsRoutes } from "./events/routes.js";
import { securityHeaders } from "./lib/security.js";
import { settingsRoutes } from "./settings/routes.js";
import { VersionCatalog } from "./versions/catalog.js";
import { versionRoutes } from "./versions/routes.js";
import { ContentCatalog } from "./content/catalog.js";
import { ContentMetaRepo } from "./content/repo.js";
import { contentRoutes } from "./content/routes.js";
import { importRoutes } from "./import/routes.js";
import { migrationGuard } from "./migration/guard.js";
import { migrationRoutes } from "./migration/routes.js";

/** `logger`: true in production; tests may pass pino options (e.g. a `stream` to capture the logs). */
export interface AppOptions {
  db: Db;
  logger?: FastifyServerOptions["logger"];
  config?: Partial<Config>;
  /** plan-10: version catalog (tests inject one with a fake fetch; they never touch the network). */
  versions?: VersionCatalog;
  /** plan-11: content catalog (tests inject one with a fake fetch; they never touch the network). */
  content?: ContentCatalog;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const cfg: Config = { ...config, ...opts.config };
  const app = Fastify({ logger: opts.logger ?? false });
  // Before registering anything: plugins inherit the handler ({ error } format, generic 5xx).
  app.setErrorHandler(errorHandler(app));
  securityHeaders(app); // plan-9 (L10): before registering anything, so every route inherits it
  app.decorate("db", opts.db);
  app.decorate("config", cfg);
  app.decorate("nodes", new NodesRepo(opts.db));

  app.get("/api/health", async () => ({ ok: true }));

  // Before the session guard: its onRequest hook must run first so that a 401 on the
  // upgrade (/ws, /agent/ws) closes the socket instead of leaving it hanging.
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  await app.register(authPlugin);
  await app.register(authRoutes);
  await app.register(migrationGuard); // plan-7 (outside anchor): migration guard BEFORE the routes it protects
  await app.register(nodeRoutes);
  app.decorate("events", new EventEmitter());
  app.decorate("agents", new AgentHub({ log: app.log }));
  app.decorate("servers", new ServersRepo(opts.db));
  await app.register(agentRoutes);
  new AgentService(app).start();
  app.addHook("onReady", async () => app.nodes.markAllOffline());
  await app.register(serverRoutes);
  await app.register(realtimeRoutes);
  // ── plan-2 ──
  await app.register(metricsPlugin);
  // ── plan-3 ──
  app.decorate("curseforge", new CurseForgeKeyRepo(opts.db));
  await app.register(curseforgeRoutes);
  app.decorate("templates", new TemplatesRepo(opts.db));
  await app.register(templateRoutes);
  // ── plan-4 ──
  await app.register(jobRoutes);
  await app.register(backupRoutes);
  // ── plan-5 ──
  await app.register(transfersPlugin);
  await app.register(fileRoutes);
  // ── plan-6 ──
  await app.register(importRoutes);
  // ── plan-7 ──
  await app.register(migrationRoutes);
  // ── plan-8 ──
  await app.register(routerRoutes);
  // ── plan-9 ──
  await app.register(eventsRoutes);
  await app.register(settingsRoutes);
  // ── plan-10 ──
  app.decorate("versions", opts.versions ?? new VersionCatalog({
    onError: (url, err) => app.log.warn({ url, err }, "could not query a version source"),
  }));
  await app.register(versionRoutes);
  // ── plan-11 ──
  app.decorate("content", opts.content ?? new ContentCatalog({
    repo: new ContentMetaRepo(opts.db),
    curseforgeKey: () => app.curseforge.get(),
    onError: (url, err) => app.log.warn({ url, err }, "could not query a content source"),
  }));
  await app.register(contentRoutes);
  app.addHook("onReady", async () => { app.content.purge(); });
  if (cfg.webDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    // The notFoundHandler does not go through the session guard (there is no routed route): it must only serve
    // index.html, never data, and only for GET/HEAD navigations outside /api, /agent and /ws.
    app.setNotFoundHandler((req, reply) => {
      let path = req.url.split("?")[0] ?? "";
      try { path = decodeURIComponent(path); } catch { /* malformed path: evaluated as is */ }
      path = path.toLowerCase();
      const reserved = ["/api", "/agent", "/ws"].some((p) => path === p || path.startsWith(`${p}/`));
      const missingAsset = path.startsWith("/assets/");
      if (reserved || missingAsset || (req.method !== "GET" && req.method !== "HEAD")) {
        return reply.code(404).send({ error: "Not found" });
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
