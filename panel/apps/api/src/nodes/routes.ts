import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
    "docker run -d --name mcsm-agent --restart unless-stopped \\",
    // Al pararse, el agente espera hasta 25 s a las copias en curso para enviar save-on.
    "  --stop-timeout 30 \\",
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
    try {
      repo.delete(node.id);
    } catch (e) {
      if (!isForeignKeyError(e)) throw e;
      return reply.code(409).send({ error: "El nodo tiene servidores; bórralos o mígralos antes" });
    }
    app.agents.get(node.id)?.terminate(); // un nodo borrado no puede seguir conectado
    return reply.code(204).send();
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
