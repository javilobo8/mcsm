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

  it("el hostname del servidor tiene que estar libre en el destino", async () => {
    const { b, s } = await nodes(spec(25565, "survival.lan"));
    app.servers.create({ nodeId: b.id, name: "Apagado", slug: "apagado", spec: spec(25570, "survival.lan", false), desiredState: "stopped" });
    expect((await proposal(s.id, b.id)).statusCode).toBe(200); // con el router desactivado no compite
    app.servers.create({ nodeId: b.id, name: "Creativo", slug: "creativo", spec: spec(25571, "survival.lan"), desiredState: "stopped" });
    const res = await proposal(s.id, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("El hostname «survival.lan» ya lo usa el servidor «Creativo» del nodo destino «nodo-b»");
    const begin = await app.inject({ method: "POST", url: `/api/servers/${s.id}/migration`, headers: { cookie }, payload: { targetNodeId: b.id } });
    expect(begin.statusCode).toBe(409);
    expect(app.migrations.latestForServer(s.id)).toBeNull();
  });

  it("el hostname de una migración abierta hacia un nodo queda reservado allí", async () => {
    const { a, b, s } = await nodes(spec(25565, "survival.lan"));
    const c = await FakeNode.enroll(app, url, cookie, "nodo-c");
    const t = app.servers.create({ nodeId: c.id, name: "Copia", slug: "copia", spec: spec(25566, "survival.lan"), desiredState: "stopped" });
    const other = app.servers.create({ nodeId: b.id, name: "Creativo", slug: "creativo", spec: spec(25571, "creativo.lan"), desiredState: "stopped" });
    const m = app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565, "survival.lan")), was_running: 1, delete_source: 0,
    });
    let res = await proposal(t.id, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("El hostname «survival.lan» lo reserva «Survival», que se está migrando al nodo destino «nodo-b»");
    // Tampoco lo coge un servidor de ese nodo mientras tanto.
    res = await app.inject({ method: "PATCH", url: `/api/servers/${other.id}`, headers: { cookie }, payload: { spec: { router: { enabled: true, hostname: "survival.lan" } } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("El hostname «survival.lan» lo reserva «Survival», que se está migrando a este nodo");
    // Deshecha (sin nada en el destino), queda libre.
    app.migrations.update(m.id, { phase: "failed" });
    expect((await proposal(t.id, b.id)).statusCode).toBe(200);
  });
});
