import type { FastifyInstance } from "fastify";
import type { VersionCatalog } from "./catalog.js";

/**
 * Listas de versiones de Minecraft y de builds/loaders por tipo (plan 10). Las sirve el panel porque la
 * CSP (connect-src 'self') no deja al navegador consultar las fuentes. Pasan por el guard de sesión.
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
