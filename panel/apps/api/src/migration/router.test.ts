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

// Plans 7 × 8: migration between nodes and each node's mc-router (reserved port, unique hostname per node,
// source autoscale).

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

/** Node router saved directly (without sending it to any agent). */
function routerRow(nodeId: string, s: Partial<RouterDeploymentSpec>) {
  app.db.prepare(`INSERT INTO router_deployments (node_id, spec, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET spec = excluded.spec`).run(nodeId, JSON.stringify(routerDeploymentSpecSchema.parse(s)), new Date().toISOString());
}

const proposal = (serverId: string, targetNodeId: string) =>
  app.inject({ method: "GET", url: `/api/servers/${serverId}/migration/proposal?targetNodeId=${targetNodeId}`, headers: { cookie } });

/** Two enrolled nodes (not connected) and a server on the first. */
async function nodes(s: Spec = spec(25565)) {
  const a = await FakeNode.enroll(app, url, cookie, "node-a");
  const b = await FakeNode.enroll(app, url, cookie, "node-b");
  const srv = app.servers.create({ nodeId: a.id, name: "Survival", slug: "survival", spec: s, desiredState: "running" });
  return { a, b, s: srv };
}

describe("migration and router (Plans 7 and 8)", () => {
  it("the target router's port is not kept: another is proposed", async () => {
    const { b, s } = await nodes();
    routerRow(b.id, { enabled: true, port: 25565 });
    expect((await proposal(s.id, b.id)).json()).toEqual({ targetNodeId: b.id, slug: "survival", port: 25566, currentPort: 25565, portChanged: true, rconPort: null, rconChanged: false });
    routerRow(b.id, { enabled: false, port: 25565 });
    expect((await proposal(s.id, b.id)).json()).toMatchObject({ port: 25565, portChanged: false });
  });

  it("the server's hostname must be free on the target", async () => {
    const { b, s } = await nodes(spec(25565, "survival.lan"));
    app.servers.create({ nodeId: b.id, name: "Apagado", slug: "apagado", spec: spec(25570, "survival.lan", false), desiredState: "stopped" });
    expect((await proposal(s.id, b.id)).statusCode).toBe(200); // with the router disabled it does not compete
    app.servers.create({ nodeId: b.id, name: "Creative", slug: "creative", spec: spec(25571, "survival.lan"), desiredState: "stopped" });
    const res = await proposal(s.id, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Hostname “survival.lan” is already used by server “Creative” on the target node “node-b”");
    const begin = await app.inject({ method: "POST", url: `/api/servers/${s.id}/migration`, headers: { cookie }, payload: { targetNodeId: b.id } });
    expect(begin.statusCode).toBe(409);
    expect(app.migrations.latestForServer(s.id)).toBeNull();
  });

  it("the hostname of an open migration towards a node is reserved there", async () => {
    const { a, b, s } = await nodes(spec(25565, "survival.lan"));
    const c = await FakeNode.enroll(app, url, cookie, "node-c");
    const t = app.servers.create({ nodeId: c.id, name: "Copy", slug: "copy", spec: spec(25566, "survival.lan"), desiredState: "stopped" });
    const other = app.servers.create({ nodeId: b.id, name: "Creative", slug: "creative", spec: spec(25571, "creative.lan"), desiredState: "stopped" });
    const m = app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565, "survival.lan")), was_running: 1, delete_source: 0,
    });
    let res = await proposal(t.id, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Hostname “survival.lan” is reserved by “Survival”, which is being migrated to the target node “node-b”");
    // Nor does a server on that node take it in the meantime.
    res = await app.inject({ method: "PATCH", url: `/api/servers/${other.id}`, headers: { cookie }, payload: { spec: { router: { enabled: true, hostname: "survival.lan" } } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Hostname “survival.lan” is reserved by “Survival”, which is being migrated to this node");
    // Once rolled back (with nothing on the target), it is free.
    app.migrations.update(m.id, { phase: "failed" });
    expect((await proposal(t.id, b.id)).statusCode).toBe(200);
  });

  it("with the source router's autoscale, a server with a hostname is not migrated (mc-router could start it on the source)", async () => {
    const { a, b, s } = await nodes(spec(25565, "survival.lan"));
    routerRow(a.id, { enabled: true, port: 25590, autoscale: true });
    let res = await proposal(s.id, b.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("“Survival” has a hostname and the router of “node-a” has autoscale enabled: mc-router could start it on the source " +
      "during the migration. Remove autoscale from the router of “node-a” or disable the server's hostname before migrating it");
    res = await app.inject({ method: "POST", url: `/api/servers/${s.id}/migration`, headers: { cookie }, payload: { targetNodeId: b.id } });
    expect(res.statusCode).toBe(409);
    // Without autoscale, yes.
    routerRow(a.id, { enabled: true, port: 25590, autoscale: false });
    expect((await proposal(s.id, b.id)).statusCode).toBe(200);
    // With autoscale, a server without an active hostname (mc-router does not see it) as well.
    routerRow(a.id, { enabled: true, port: 25590, autoscale: true });
    const t = app.servers.create({ nodeId: a.id, name: "Bare", slug: "bare", spec: spec(25566, "bare.lan", false), desiredState: "stopped" });
    expect((await proposal(t.id, b.id)).statusCode).toBe(200);
  });

  it("with an open migration of a server with a hostname, the source's router does not enable autoscale", async () => {
    const { a, b, s } = await nodes(spec(25565, "survival.lan"));
    const m = app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565, "survival.lan")), was_running: 1, delete_source: 0,
    });
    const put = (payload: object) => app.inject({ method: "PUT", url: `/api/nodes/${a.id}/router`, headers: { cookie }, payload });
    let res = await put({ enabled: true, port: 25590, autoscale: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("“Survival” has a hostname and is being migrated from this node: enable autoscale when the migration ends " +
      "(mc-router could start it here midway)");
    expect(app.routerService.get(a.id).spec.enabled).toBe(false); // nothing was saved
    expect((await put({ enabled: true, port: 25590 })).statusCode).toBe(200); // without autoscale, yes (node offline: it is saved)
    app.migrations.update(m.id, { phase: "failed" });
    expect((await put({ enabled: true, port: 25590, autoscale: true })).statusCode).toBe(200);
  });

  it("the router is not enabled on a port reserved by a migration towards the node", async () => {
    const { a, b, s } = await nodes();
    app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: a.id, target_node_id: b.id, source_slug: "survival", target_slug: "survival",
      source_version: 1, target_version: 2, target_port: 25570, target_spec: JSON.stringify(spec(25570)), was_running: 1, delete_source: 0,
    });
    const put = (payload: object) => app.inject({ method: "PUT", url: `/api/nodes/${b.id}/router`, headers: { cookie }, payload });
    const res = await put({ enabled: true, port: 25570 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Port 25570 is reserved by a migration in progress towards this node: choose another port for the router");
    expect(app.routerService.get(b.id).spec.enabled).toBe(false);
    expect((await put({ enabled: true, port: 25571 })).statusCode).toBe(200);
  });
});
