import type { FastifyInstance } from "fastify";
import type { VersionCatalog } from "./catalog.js";

/**
 * Lists of Minecraft versions and of builds/loaders per type (plan 10). Served by the panel because the
 * CSP (connect-src 'self') does not let the browser query the sources. They go through the session guard.
 */
export async function versionRoutes(app: FastifyInstance) {
  app.get<{ Params: { type: string } }>("/api/versions/:type", async (req) => app.versions.versions(req.params.type));
  app.get<{ Params: { type: string; version: string } }>("/api/versions/:type/:version/builds", async (req) =>
    app.versions.builds(req.params.type, req.params.version));
}

declare module "fastify" {
  interface FastifyInstance {
    versions: VersionCatalog;
  }
}
