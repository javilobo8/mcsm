import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentError } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { hashToken, randomToken } from "../lib/tokens.js";
import { isForeignKeyError, toNodeDto } from "./repo.js";

const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u, "Nombre inválido");
const dataRootSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9._/-]{1,200}$/, "Ruta inválida: debe ser absoluta y solo con letras, números, . _ - /")
  .refine((p) => !p.split("/").includes(".."), "Ruta inválida: no se admite '..'");

// Valores seguros para shell sin comillas; el resto se entrecomilla con comillas simples.
const SHELL_SAFE = /^[A-Za-z0-9._/:=@%+,-]+$/;
export const shellArg = (v: string): string => (SHELL_SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

export function dockerRunSnippet(publicUrl: string, token: string, dataRoot = "/srv/minecraft"): string {
  return [
    "docker network create mcsm 2>/dev/null || true",
    // --stop-timeout: docker stop mata a los 10 s; al pararse, el agente espera a la vez, hasta 25 s,
    // a sus operaciones de archivos y a las copias en curso (save-on).
    "docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \\",
    "  --network mcsm \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${shellArg(dataRoot)}:${shellArg(dataRoot)} \\`,
    "  -v mcsm-agent-data:/var/lib/mcsm-agent \\",
    "  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \\",
    `  -e PANEL_URL=${shellArg(publicUrl)} \\`,
    `  -e ENROLL_TOKEN=${shellArg(token)} \\`,
    `  -e DATA_ROOT=${shellArg(dataRoot)} \\`,
    "  mcsm-agent:latest",
  ].join("\n");
}

/** Una rotación sin confirmar más reciente que esto bloquea otra: el agente aún puede conectar con su token. */
const ROTATION_WINDOW_MS = 2 * 60_000;

export async function nodeRoutes(app: FastifyInstance) {
  const repo = app.nodes;

  app.get("/api/nodes", async () => repo.list().map(toNodeDto));

  app.post("/api/nodes/enrollment-tokens", async (req, reply) => {
    const body = z.object({ nameHint: nameSchema.default("nodo"), dataRoot: dataRootSchema.default("/srv/minecraft") }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    // req.host conserva el puerto (req.hostname no): sin él el agente no conectaría.
    const publicUrl = app.config.publicUrl || `http://${req.host}`;
    const { token, expiresAt } = repo.createEnrollmentToken(body.data.nameHint, app.config.enrollTtlSeconds, body.data.dataRoot);
    return { token, expiresAt, dockerRun: dockerRunSnippet(publicUrl, token, body.data.dataRoot) };
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Nodo no encontrado" });
    const body = z.object({ name: nameSchema.optional(), dataRoot: dataRootSchema.optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    if (body.data.name && body.data.name !== node.name) {
      if (repo.nameExists(body.data.name)) return reply.code(409).send({ error: "Ya existe un nodo con ese nombre" });
      repo.rename(node.id, body.data.name);
    }
    if (body.data.dataRoot) repo.setDataRoot(node.id, body.data.dataRoot);
    return toNodeDto(repo.get(node.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Nodo no encontrado" });
    // plan-8: su contenedor mcsm-router quedaría huérfano en esa máquina (ver RouterService.deleteBlock).
    const routerBlock = app.routerService.deleteBlock(node.id);
    if (routerBlock) return reply.code(409).send({ error: routerBlock });
    try {
      repo.delete(node.id);
    } catch (e) {
      if (!isForeignKeyError(e)) throw e;
      return reply.code(409).send({ error: "El nodo tiene servidores; bórralos o mígralos antes" });
    }
    app.agents.get(node.id)?.terminate(); // un nodo borrado no puede seguir conectado
    return reply.code(204).send();
  });

  // Rotación del token del nodo (spec §9, L5 del Plan 1). POST bajo /api/nodes/:id/: la guarda de migraciones la
  // bloquea mientras el nodo migra (la rotación reconecta el agente).
  app.post<{ Params: { id: string } }>("/api/nodes/:id/rotate-token", async (req) => {
    const node = repo.get(req.params.id);
    if (!node) throw new HttpError(404, "Nodo no encontrado");
    const conn = app.agents.get(node.id);
    if (!conn) throw new HttpError(409, "El nodo está desconectado: la rotación necesita el agente conectado");
    if (node.pending_token_hash && node.pending_token_at && Date.parse(node.pending_token_at) > Date.now() - ROTATION_WINDOW_MS) {
      throw new HttpError(409, "Ya hay una rotación en curso: espera a que el agente se reconecte con el token nuevo");
    }
    const token = randomToken();
    // Antes de enviarlo: si el Ack se pierde, el agente puede volver ya con el token nuevo.
    repo.setPendingToken(node.id, hashToken(token));
    try {
      await conn.request({ case: "rotateToken", value: { token } }, 30_000);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Timeout || e.code === AgentErrorCode.Disconnected)) {
        req.log.warn({ nodeId: node.id, code: e.code }, "rotación de token sin confirmar; el token nuevo queda pendiente");
        throw new HttpError(504, "El agente no confirmó la rotación. Si guardó el token nuevo se reconectará con él en unos segundos; si no, vuelve a intentarlo pasados 2 minutos");
      }
      repo.setPendingToken(node.id, null);
      if (e instanceof AgentError && e.code === AgentErrorCode.Unsupported) {
        throw new HttpError(409, "El agente de este nodo no admite la rotación de token: actualízalo primero");
      }
      throw agentErrorToHttp(e, "El agente no pudo guardar el token nuevo");
    }
    req.log.info({ nodeId: node.id }, "token de nodo rotado; esperando a que el agente se reconecte");
    return toNodeDto(repo.get(node.id)!);
  });

  // Sin sesión: lo llama el agente con el token de alta.
  app.post("/agent/enroll", async (req, reply) => {
    const body = z.object({ enrollToken: z.string().min(1), nameHint: z.string().optional(), agentVersion: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Petición inválida" });
    const result = repo.enrollNode(body.data.enrollToken, body.data.agentVersion);
    if (!result) return reply.code(401).send({ error: "Token de alta inválido, caducado o ya usado" });
    req.log.info({ nodeId: result.nodeId }, "nodo dado de alta");
    return { nodeId: result.nodeId, nodeToken: result.nodeToken };
  });
}
