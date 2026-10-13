import type { Readable } from "node:stream";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { drain } from "../files/stream.js";
import { HttpError } from "../lib/http.js";
import { MigrationsRepo } from "./repo.js";

export type GuardSubject =
  | { kind: "server"; serverId: string }
  | { kind: "create"; nodeId: string }
  | { kind: "deleteNode"; nodeId: string }
  | null;

const READ = new Set(["GET", "HEAD", "OPTIONS"]);
const MIGRATION_ROUTE = "/api/servers/:id/migration";

/**
 * What the guard protects in a request. It decides by the routed route (`req.routeOptions.url`), like the session
 * guard, never by the raw URL. Pure.
 * - Any non-GET method under /api/servers/:id (except the migration routes): the server.
 * - Creating servers (POST /api/servers, /api/templates/:id/servers with `nodeId` in the body, and any
 *   POST /api/nodes/:id/…, such as the Plan 6 import): the node.
 * - DELETE /api/nodes/:id: the node.
 */
export function guardSubject(method: string, route: string | undefined, params: unknown, body: unknown): GuardSubject {
  if (!route || READ.has(method)) return null;
  const rawId = (params as { id?: unknown } | null | undefined)?.id;
  const id = typeof rawId === "string" && rawId !== "" ? rawId : null;
  if (route === MIGRATION_ROUTE || route.startsWith(`${MIGRATION_ROUTE}/`)) return null;
  if (route === "/api/servers/:id" || route.startsWith("/api/servers/:id/")) return id ? { kind: "server", serverId: id } : null;
  if (route === "/api/servers" || route === "/api/templates/:id/servers") {
    const nodeId = (body as { nodeId?: unknown } | null | undefined)?.nodeId;
    return typeof nodeId === "string" && nodeId !== "" ? { kind: "create", nodeId } : null;
  }
  if (route === "/api/nodes/:id") return method === "DELETE" && id ? { kind: "deleteNode", nodeId: id } : null;
  if (route.startsWith("/api/nodes/:id/") && method === "POST") return id ? { kind: "create", nodeId: id } : null;
  return null;
}

function blockError(app: FastifyInstance, s: NonNullable<GuardSubject>): HttpError | null {
  if (s.kind === "server") {
    const m = app.migrations.blockingServer(s.serverId);
    if (!m) return null;
    const name = app.servers.get(s.serverId)?.name ?? "The server";
    return new HttpError(409, m.phase === "running"
      ? `“${name}” is being migrated to another node: wait for it to finish (Migrate tab)`
      : `A failed migration of “${name}” is being rolled back: wait for it to finish (Migrate tab)`);
  }
  const m = s.kind === "create" ? app.migrations.blockingNodeCreate(s.nodeId) : app.migrations.blockingNodeDelete(s.nodeId);
  if (!m) return null;
  return new HttpError(409, `Node “${app.nodes.get(s.nodeId)?.name ?? s.nodeId}” is part of a migration in progress: wait for it to finish (Jobs)`);
}

/**
 * Decorates `app.migrations` and adds the migration guard: a root `preHandler` hook that responds 409 to whatever
 * would change a server or a node with an open migration. It is registered BEFORE the routes: Fastify fixes the hooks
 * of each context at registration, so a root hook added later would not reach them.
 */
export const migrationGuard = fp(async function migrationGuard(app: FastifyInstance) {
  app.decorate("migrations", new MigrationsRepo(app.db));
  app.addHook("preHandler", async (req, reply) => {
    const s = guardSubject(req.method, req.routeOptions.url, req.params, req.body);
    if (!s) return;
    const err = blockError(app, s);
    if (!err) return;
    // An upload (PUT …/files/upload) arrives as a stream: it is drained (bounded) so the browser receives the 409 as
    // JSON and not a network cut; if too much remains, the response closes the connection (as the Files route does).
    const body = req.body as Readable | undefined;
    if (body && typeof body.pipe === "function" && !(await drain(body))) reply.header("connection", "close");
    throw err;
  });
}, { name: "migration-guard" });

declare module "fastify" {
  interface FastifyInstance { migrations: MigrationsRepo }
}
