import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NodesRepo, toNodeDto } from "./repo.js";
import { hashToken, randomToken } from "../lib/tokens.js";

const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u, "Nombre inválido");

export function dockerRunSnippet(publicUrl: string, token: string, dataRoot = "/srv/minecraft"): string {
  return [
    "docker network create mcsm 2>/dev/null || true",
    "docker run -d --name mcsm-agent --restart unless-stopped \\",
    "  --network mcsm \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${dataRoot}:${dataRoot} \\`,
    "  -v mcsm-agent-data:/var/lib/mcsm-agent \\",
    "  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \\",
    `  -e PANEL_URL=${publicUrl} \\`,
    `  -e ENROLL_TOKEN=${token} \\`,
    `  -e DATA_ROOT=${dataRoot} \\`,
    "  mcsm-agent:latest",
  ].join("\n");
}

export async function nodeRoutes(app: FastifyInstance) {
  const repo = new NodesRepo(app.db);
  app.decorate("nodes", repo);

  app.get("/api/nodes", async () => repo.list().map(toNodeDto));

  app.post("/api/nodes/enrollment-tokens", async (req, reply) => {
    const body = z.object({ nameHint: nameSchema.default("nodo"), dataRoot: z.string().startsWith("/").default("/srv/minecraft") }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const publicUrl = app.config.publicUrl || `http://${req.hostname}`;
    const { token, expiresAt } = repo.createEnrollmentToken(body.data.nameHint, app.config.enrollTtlSeconds);
    return { token, expiresAt, dockerRun: dockerRunSnippet(publicUrl, token, body.data.dataRoot) };
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Nodo no encontrado" });
    const body = z.object({ name: nameSchema.optional(), dataRoot: z.string().startsWith("/").optional() }).safeParse(req.body ?? {});
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
      return reply.code(409).send({ error: "El nodo tiene servidores; bórralos o mígralos antes" });
    }
    return reply.code(204).send();
  });

  // Sin sesión: lo llama el agente con el token de alta.
  app.post("/agent/enroll", async (req, reply) => {
    const body = z.object({ enrollToken: z.string().min(1), nameHint: z.string().optional(), agentVersion: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Petición inválida" });
    const hint = repo.consumeEnrollmentToken(body.data.enrollToken);
    if (hint === null) return reply.code(401).send({ error: "Token de alta inválido, caducado o ya usado" });
    let name = hint;
    for (let i = 2; repo.nameExists(name); i++) name = `${hint}-${i}`;
    const nodeToken = randomToken();
    const node = repo.create({ name, tokenHash: hashToken(nodeToken) });
    if (body.data.agentVersion) repo.setStatus(node.id, "offline", { agentVersion: body.data.agentVersion });
    req.log.info({ nodeId: node.id, name }, "nodo dado de alta");
    return { nodeId: node.id, nodeToken };
  });
}

declare module "fastify" {
  interface FastifyInstance { nodes: NodesRepo }
}
