import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { routerDeploymentSpecSchema, specSchema, type RouterDeploymentSpec, type Spec } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { FakeNode } from "../../test/fake-node.js";

// Planes 7 × 8: la migración entre nodos y el mc-router de cada nodo (puerto reservado, hostname único por nodo,
// autoscale del origen).

let app: FastifyInstance; let url: string; let cookie: string; let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mcsm-migr-"));
  app = await buildApp({ db: openDb(":memory:"), config: { dataDir } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const spec = (game: number, hostname?: string, enabled = true): Spec => specSchema.parse({
  type: "PAPER", version: "1.21.4", memory: "2G", ports: { game }, rconPassword: "abcdefgh",
  ...(hostname ? { router: { enabled, hostname } } : {}),
});

/** Router del nodo guardado directamente (sin enviarlo a ningún agente). */
function routerRow(nodeId: string, s: Partial<RouterDeploymentSpec>) {
  app.db.prepare(`INSERT INTO router_deployments (node_id, spec, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET spec = excluded.spec`).run(nodeId, JSON.stringify(routerDeploymentSpecSchema.parse(s)), new Date().toISOString());
}

const proposal = (serverId: string, targetNodeId: string) =>
  app.inject({ method: "GET", url: `/api/servers/${serverId}/migration/proposal?targetNodeId=${targetNodeId}`, headers: { cookie } });

/** Dos nodos dados de alta (sin conectar) y un servidor en el primero. */
async function nodes(s: Spec = spec(25565)) {
  const a = await FakeNode.enroll(app, url, cookie, "nodo-a");
  const b = await FakeNode.enroll(app, url, cookie, "nodo-b");
  const srv = app.servers.create({ nodeId: a.id, name: "Survival", slug: "survival", spec: s, desiredState: "running" });
  return { a, b, s: srv };
}

describe("migración y router (Planes 7 y 8)", () => {
  it("el puerto del router del destino no se conserva: se propone otro", async () => {
    const { b, s } = await nodes();
    routerRow(b.id, { enabled: true, port: 25565 });
    expect((await proposal(s.id, b.id)).json()).toEqual({ targetNodeId: b.id, slug: "survival", port: 25566, currentPort: 25565, portChanged: true });
    routerRow(b.id, { enabled: false, port: 25565 });
    expect((await proposal(s.id, b.id)).json()).toMatchObject({ port: 25565, portChanged: false });
  });
});
