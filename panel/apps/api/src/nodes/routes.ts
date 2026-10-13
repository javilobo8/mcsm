import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentError } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "../lib/http.js";
import { hashToken, randomToken } from "../lib/tokens.js";
import { isForeignKeyError, toNodeDto } from "./repo.js";

const nameSchema = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u, "Invalid name");
const dataRootSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9._/-]{1,200}$/, "Invalid path: must be absolute and only contain letters, numbers, . _ - /")
  .refine((p) => !p.split("/").includes(".."), "Invalid path: '..' is not allowed");

// Values that are safe for the shell unquoted; the rest are single-quoted.
const SHELL_SAFE = /^[A-Za-z0-9._/:=@%+,-]+$/;
export const shellArg = (v: string): string => (SHELL_SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);

export function dockerRunSnippet(publicUrl: string, token: string, dataRoot = "/srv/minecraft", image = "mcsm-agent:latest"): string {
  return [
    "docker network create mcsm 2>/dev/null || true",
    // --stop-timeout: docker stop kills after 10 s; when stopping, the agent waits in parallel, up to 25 s,
    // for its file operations and the backups in progress (save-on).
    "docker run -d --name mcsm-agent --restart unless-stopped --stop-timeout 30 \\",
    "  --network mcsm \\",
    "  -v /var/run/docker.sock:/var/run/docker.sock \\",
    `  -v ${shellArg(dataRoot)}:${shellArg(dataRoot)} \\`,
    "  -v mcsm-agent-data:/var/lib/mcsm-agent \\",
    "  -v /proc:/host/proc:ro -e HOST_PROC=/host/proc \\",
    `  -e PANEL_URL=${shellArg(publicUrl)} \\`,
    `  -e ENROLL_TOKEN=${shellArg(token)} \\`,
    `  -e DATA_ROOT=${shellArg(dataRoot)} \\`,
    `  ${shellArg(image)}`,
  ].join("\n");
}

/** An unconfirmed rotation more recent than this blocks another: the agent may still connect with its token. */
const ROTATION_WINDOW_MS = 2 * 60_000;

export async function nodeRoutes(app: FastifyInstance) {
  const repo = app.nodes;

  app.get("/api/nodes", async () => repo.list().map(toNodeDto));

  app.post("/api/nodes/enrollment-tokens", async (req, reply) => {
    const body = z.object({ nameHint: nameSchema.default("node"), dataRoot: dataRootSchema.default("/srv/minecraft") }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    // req.host keeps the port (req.hostname does not): without it the agent would not connect.
    const publicUrl = app.settings.publicUrl() || `http://${req.host}`;
    const { token, expiresAt } = repo.createEnrollmentToken(body.data.nameHint, app.config.enrollTtlSeconds, body.data.dataRoot);
    return { token, expiresAt, dockerRun: dockerRunSnippet(publicUrl, token, body.data.dataRoot, app.config.agentImage) };
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Node not found" });
    const body = z.object({ name: nameSchema.optional(), dataRoot: dataRootSchema.optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    if (body.data.name && body.data.name !== node.name) {
      if (repo.nameExists(body.data.name)) return reply.code(409).send({ error: "A node with that name already exists" });
      repo.rename(node.id, body.data.name);
    }
    if (body.data.dataRoot) repo.setDataRoot(node.id, body.data.dataRoot);
    return toNodeDto(repo.get(node.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = repo.get(req.params.id);
    if (!node) return reply.code(404).send({ error: "Node not found" });
    // plan-8: its mcsm-router container would be left orphaned on that machine (see RouterService.deleteBlock).
    const routerBlock = app.routerService.deleteBlock(node.id);
    if (routerBlock) return reply.code(409).send({ error: routerBlock });
    try {
      repo.delete(node.id);
    } catch (e) {
      if (!isForeignKeyError(e)) throw e;
      return reply.code(409).send({ error: "The node has servers; delete or migrate them first" });
    }
    app.agents.get(node.id)?.terminate(); // a deleted node cannot stay connected
    app.metrics.forgetNode(node.id);
    return reply.code(204).send();
  });

  // Node token rotation (spec §9, L5 of Plan 1). POST under /api/nodes/:id/: the migration guard
  // blocks it while the node is migrating (the rotation reconnects the agent).
  app.post<{ Params: { id: string } }>("/api/nodes/:id/rotate-token", async (req) => {
    const node = repo.get(req.params.id);
    if (!node) throw new HttpError(404, "Node not found");
    const conn = app.agents.get(node.id);
    if (!conn?.isOpen) throw new HttpError(409, "The node is offline: the rotation needs the agent connected");
    if (node.pending_token_hash && node.pending_token_at && Date.parse(node.pending_token_at) > Date.now() - ROTATION_WINDOW_MS) {
      throw new HttpError(409, "A rotation is already in progress: wait for the agent to reconnect with the new token");
    }
    const token = randomToken();
    // Before sending it: if the Ack is lost, the agent may already come back with the new token.
    repo.setPendingToken(node.id, hashToken(token));
    try {
      await conn.request({ case: "rotateToken", value: { token } }, 30_000);
    } catch (e) {
      if (e instanceof AgentError && (e.code === AgentErrorCode.Timeout || e.code === AgentErrorCode.Disconnected)) {
        req.log.warn({ nodeId: node.id, code: e.code }, "token rotation unconfirmed; the new token stays pending");
        throw new HttpError(504, "The agent did not confirm the rotation. If it saved the new token it will reconnect with it in a few seconds; if not, try again after 2 minutes");
      }
      repo.setPendingToken(node.id, null);
      if (e instanceof AgentError && e.code === AgentErrorCode.Unsupported) {
        throw new HttpError(409, "The agent on this node does not support token rotation: update it first");
      }
      throw agentErrorToHttp(e, "The agent could not save the new token");
    }
    req.log.info({ nodeId: node.id }, "node token rotated; waiting for the agent to reconnect");
    return toNodeDto(repo.get(node.id)!);
  });

  // No session: called by the agent with the enrollment token.
  app.post("/agent/enroll", async (req, reply) => {
    const body = z.object({ enrollToken: z.string().min(1), nameHint: z.string().optional(), agentVersion: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const result = repo.enrollNode(body.data.enrollToken, body.data.agentVersion);
    if (!result) return reply.code(401).send({ error: "Invalid, expired or already used enrollment token" });
    req.log.info({ nodeId: result.nodeId }, "node enrolled");
    return { nodeId: result.nodeId, nodeToken: result.nodeToken };
  });
}
