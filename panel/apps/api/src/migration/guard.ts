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
 * Qué protege la guarda en una petición. Decide por la ruta enrutada (`req.routeOptions.url`), como el guard de
 * sesión, nunca por la URL cruda. Pura.
 * - Cualquier método no GET bajo /api/servers/:id (salvo las rutas de la migración): el servidor.
 * - Crear servidores (POST /api/servers, /api/templates/:id/servers con `nodeId` en el cuerpo, y cualquier
 *   POST /api/nodes/:id/…, como la importación del Plan 6): el nodo.
 * - DELETE /api/nodes/:id: el nodo.
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
    const name = app.servers.get(s.serverId)?.name ?? "El servidor";
    return new HttpError(409, m.phase === "running"
      ? `«${name}» se está migrando a otro nodo: espera a que termine (pestaña Migrar)`
      : `Se está deshaciendo una migración fallida de «${name}»: espera a que termine (pestaña Migrar)`);
  }
  const m = s.kind === "create" ? app.migrations.blockingNodeCreate(s.nodeId) : app.migrations.blockingNodeDelete(s.nodeId);
  if (!m) return null;
  return new HttpError(409, `El nodo «${app.nodes.get(s.nodeId)?.name ?? s.nodeId}» participa en una migración en curso: espera a que termine (Jobs)`);
}

/**
 * Decora `app.migrations` y añade la guarda de migraciones: un hook `preHandler` raíz que responde 409 a lo que
 * cambiaría un servidor o un nodo con una migración abierta. Se registra ANTES de las rutas: Fastify fija los hooks
 * de cada contexto al registrarlo, así que un hook raíz añadido después no llegaría a ellas.
 */
export const migrationGuard = fp(async function migrationGuard(app: FastifyInstance) {
  app.decorate("migrations", new MigrationsRepo(app.db));
  app.addHook("preHandler", async (req, reply) => {
    const s = guardSubject(req.method, req.routeOptions.url, req.params, req.body);
    if (!s) return;
    const err = blockError(app, s);
    if (!err) return;
    // Una subida (PUT …/files/upload) llega como stream: se drena (acotado) para que el navegador reciba el 409 en
    // JSON y no un corte de red; si queda demasiado, la respuesta cierra la conexión (como hace la ruta de Archivos).
    const body = req.body as Readable | undefined;
    if (body && typeof body.pipe === "function" && !(await drain(body))) reply.header("connection", "close");
    throw err;
  });
}, { name: "migration-guard" });

declare module "fastify" {
  interface FastifyInstance { migrations: MigrationsRepo }
}
