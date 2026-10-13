import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { newId } from "../lib/ids.js";
import type { ObservedDto } from "../servers/repo.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { guardSubject } from "./guard.js";
import type { NewMigration } from "./repo.js";
import { targetRow } from "./steps.js";

let app: FastifyInstance; let url: string; let cookie: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

const spec = (game: number) => specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game }, rconPassword: "abcdefgh" });

async function enroll(name: string): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

function newMigration(serverId: string, source: string, target: string, over: Partial<NewMigration> = {}): NewMigration {
  return {
    id: newId(), server_id: serverId, source_node_id: source, target_node_id: target, source_slug: "uno", target_slug: "uno",
    source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec(25565)), was_running: 1, delete_source: 0, ...over,
  };
}

const observed: ObservedDto = {
  containerId: "c1", state: "running", health: "healthy", startedAtUnix: 1, exitCode: 0, appliedVersion: 3, error: "",
  mc: { online: true, playersOnline: 0, playersMax: 20, version: "1.21.4", latencyMs: 3 },
};

describe("guardSubject", () => {
  it.each([
    ["GET", "/api/servers/:id", { id: "s" }, undefined, null],
    ["POST", "/api/servers/:id/power", { id: "s" }, {}, { kind: "server", serverId: "s" }],
    ["PATCH", "/api/servers/:id", { id: "s" }, {}, { kind: "server", serverId: "s" }],
    ["DELETE", "/api/servers/:id", { id: "s" }, undefined, { kind: "server", serverId: "s" }],
    ["PUT", "/api/servers/:id/files/upload", { id: "s" }, undefined, { kind: "server", serverId: "s" }],
    ["POST", "/api/servers/:id/migration", { id: "s" }, {}, null],
    ["POST", "/api/servers", undefined, { nodeId: "n" }, { kind: "create", nodeId: "n" }],
    ["POST", "/api/templates/:id/servers", { id: "t" }, { nodeId: "n" }, { kind: "create", nodeId: "n" }],
    ["POST", "/api/nodes/:id/import", { id: "n" }, {}, { kind: "create", nodeId: "n" }],
    ["DELETE", "/api/nodes/:id", { id: "n" }, undefined, { kind: "deleteNode", nodeId: "n" }],
    ["PATCH", "/api/nodes/:id", { id: "n" }, {}, null],
    ["POST", "/api/auth/login", undefined, {}, null],
    ["POST", undefined, undefined, {}, null],
  ])("%s %s", (method, route, params, body, want) => {
    expect(guardSubject(method as string, route as string | undefined, params, body)).toEqual(want);
  });
});

describe("MigrationsRepo", () => {
  it("commit: moves the row only if it is still on the source with the same version and without breaking the unique slug", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m1 = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.servers.bumpVersion(s.id); // the spec changed during the migration
    expect(app.migrations.commit(m1, "running", observed)).toBe(false);
    expect(app.servers.get(s.id)!.node_id).toBe(a.nodeId);
    expect(app.migrations.get(m1.id)!.phase).toBe("running");

    const m2 = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, {
      source_version: 2, target_version: 3, target_port: 25570, target_spec: JSON.stringify(spec(25570)),
    }));
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "uno", spec: spec(25580), desiredState: "stopped" });
    expect(app.migrations.commit(m2, "running", observed)).toBe(false); // slug taken on the target
    app.servers.delete(other.id);

    expect(app.migrations.commit(m2, "stopped", observed)).toBe(true);
    const row = app.servers.get(s.id)!;
    expect(row).toMatchObject({ node_id: b.nodeId, slug: "uno", spec_version: 3, desired_state: "stopped", observed_spec_version: 3 });
    expect(row.desired_changed_at).not.toBeNull(); // the commit changes the desired state: it marks the time (a late crash_loop does not undo it)
    expect(JSON.parse(row.spec).ports.game).toBe(25570);
    expect(JSON.parse(row.observed!).containerId).toBe("c1");
    expect(app.migrations.get(m2.id)).toMatchObject({ phase: "committed", source_pending: 1 });
  });

  it("commit: an imported server (imported_from, Plan 6) stops following its original container", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    app.servers.setImportedFrom(s.id, {
      containerId: "c".repeat(64), containerName: "mc-viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z", composeProject: "", composeService: "",
    });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    expect(app.servers.get(s.id)!.imported_from).toMatch(/mc-viejo/);
    expect(targetRow(app.servers.get(s.id)!, m, "stopped").imported_from).toBeNull();
    expect(app.migrations.commit(m, "running", null)).toBe(true);
    expect(app.servers.get(s.id)!.imported_from).toBeNull();
  });

  it("failed commit: an imported one keeps its imported_from on the source", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    app.servers.setImportedFrom(s.id, {
      containerId: "c".repeat(64), containerName: "mc-viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z", composeProject: "", composeService: "",
    });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.servers.bumpVersion(s.id); // the spec changed during the migration: the commit moves nothing
    expect(app.migrations.commit(m, "running", null)).toBe(false);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.nodeId });
    expect(app.servers.get(s.id)!.imported_from).toMatch(/mc-viejo/);
  });

  it("commit: fails if another server on the target already uses the game port or an extra port (M1)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { target_port: 25570, target_spec: JSON.stringify(spec(25570)) }));
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "otro", spec: spec(25571), desiredState: "stopped" });
    // Someone changed B's other server to use the reserved port (without going through checkPorts).
    app.servers.updateSpec(other.id, spec(25570));
    expect(app.migrations.commit(m, "running", observed)).toBe(false);
    expect(app.servers.get(s.id)!.node_id).toBe(a.nodeId);
    expect(app.migrations.get(m.id)!.phase).toBe("running");
    app.servers.updateSpec(other.id, specSchema.parse({ ...spec(25572), ports: { game: 25572, extra: [{ host: 25570, container: 19132, proto: "udp" }] } }));
    expect(app.migrations.commit(m, "running", observed)).toBe(false);
    app.servers.updateSpec(other.id, spec(25572));
    expect(app.migrations.commit(m, "running", observed)).toBe(true);
  });

  it("checkPorts and allocatePort count the ports reserved by migrations towards the node (M1)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "otro", spec: spec(25571), desiredState: "stopped" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { target_port: 25566, target_spec: JSON.stringify(spec(25566)) }));
    const patch = await app.inject({ method: "PATCH", url: `/api/servers/${other.id}`, headers: { cookie }, payload: { spec: { ports: { game: 25566 } } } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error).toMatch(/25566/);
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25565);
    app.servers.updateSpec(other.id, spec(25565));
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25567); // 25566 is reserved by the migration
    app.migrations.update(m.id, { phase: "failed" });
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25566);
  });

  it("blockingServer and blockingNodeCreate only while there can be a conflict (I2)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    const cases: [Parameters<typeof app.migrations.update>[1], boolean, boolean][] = [
      // patch, blocks the server, blocks creating on the target
      [{ phase: "rolling_back", source_pending: 1, target_pending: 1, target_started: 0 }, true, true],
      [{ phase: "rolling_back", source_pending: 0, target_pending: 1, target_started: 1 }, true, true],
      [{ phase: "rolling_back", source_pending: 0, target_pending: 1, target_started: 0 }, false, true],
      [{ phase: "rolling_back", source_pending: 1, target_pending: 0, target_started: 1 }, true, false],
      [{ phase: "rolling_back", source_pending: 0, target_pending: 0, target_started: 1 }, false, false],
    ];
    for (const [patch, server, create] of cases) {
      app.migrations.update(m.id, patch);
      expect(app.migrations.blockingServer(s.id) !== null, JSON.stringify(patch)).toBe(server);
      expect(app.migrations.blockingNodeCreate(b.nodeId) !== null, JSON.stringify(patch)).toBe(create);
    }
  });

  it("interruptRunning, protects and the blocking queries", async () => {
    const a = await enroll("a"); const b = await enroll("b"); const c = await enroll("c");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const s2 = app.servers.create({ nodeId: c.nodeId, name: "Dos", slug: "dos", spec: spec(25566), desiredState: "running" });
    const run = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.migrations.update(run.id, { target_touched: 1, target_started: 1 });
    const com = app.migrations.insert(newMigration(s2.id, c.nodeId, b.nodeId));
    app.migrations.update(com.id, { phase: "committed", source_pending: 1 });

    expect(app.migrations.protects(a.nodeId, s.id)).toBe(true);
    expect(app.migrations.protects(b.nodeId, s.id)).toBe(true);
    expect(app.migrations.protects(c.nodeId, s.id)).toBe(false);
    expect(app.migrations.blockingServer(s.id)?.id).toBe(run.id);
    expect(app.migrations.blockingServer(s2.id)).toBeNull(); // confirmed: the server is free now
    expect(app.migrations.blockingNodeCreate(b.nodeId)?.id).toBe(run.id);
    expect(app.migrations.blockingNodeCreate(c.nodeId)?.id).toBe(com.id); // source pending removal
    expect(app.migrations.blockingNodeDelete(b.nodeId)?.id).toBe(run.id);
    expect(app.migrations.blockingNodeDelete(c.nodeId)).toBeNull();

    const out = app.migrations.interruptRunning("interrumpido");
    expect(out.map((r) => r.id)).toEqual([run.id]);
    expect(app.migrations.get(run.id)).toMatchObject({ phase: "rolling_back", target_pending: 1, source_pending: 1, target_started: 1, error: "interrumpido" });
    expect(app.migrations.get(com.id)!.phase).toBe("committed");
    expect(app.migrations.listOpen().map((r) => r.id).sort()).toEqual([run.id, com.id].sort());
    expect(app.migrations.blockingNodeDelete(b.nodeId)).toBeNull(); // rolling back: the target can be deleted
    app.migrations.update(run.id, { phase: "failed", target_pending: 0, source_pending: 0 });
    expect(app.migrations.protects(b.nodeId, s.id)).toBe(false);
    expect(app.migrations.latestForServer(s.id)?.phase).toBe("failed");
    expect(app.migrations.openForServer(s.id)).toBeNull();
  });
});

describe("action guard", () => {
  it("blocks what changes the server or nodes while it lasts; reads continue", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    const call = (method: "GET" | "POST" | "PATCH" | "DELETE", u: string, payload?: object) =>
      app.inject({ method, url: u, headers: { cookie }, ...(payload ? { payload } : {}) });

    const blocked: [("POST" | "PATCH" | "DELETE"), string, object?][] = [
      ["POST", `/api/servers/${s.id}/power`, { action: "start" }],
      ["PATCH", `/api/servers/${s.id}`, { name: "Otro" }],
      ["DELETE", `/api/servers/${s.id}`],
      ["POST", `/api/servers/${s.id}/backups`],
      ["POST", `/api/servers/${s.id}/command`, { command: "list" }],
    ];
    for (const [method, u, payload] of blocked) {
      const r = await call(method, u, payload);
      expect(r.statusCode, `${method} ${u}`).toBe(409);
      expect(r.json().error).toMatch(/“Uno” is being migrated/);
    }
    expect((await call("GET", `/api/servers/${s.id}`)).statusCode).toBe(200);
    const create = await call("POST", "/api/servers", { nodeId: b.nodeId, name: "Nuevo", spec: {} });
    expect(create.statusCode).toBe(409);
    expect(create.json().error).toMatch(/is part of a migration/);
    // Plan 6: importing a container on the target node also creates a server there (the guard runs before the route).
    const imported = await call("POST", `/api/nodes/${b.nodeId}/import`, { containerId: "c".repeat(64), name: "Importado", spec: {}, applyNow: false });
    expect(imported.statusCode).toBe(409);
    expect(imported.json().error).toMatch(/is part of a migration/);
    expect((await call("DELETE", `/api/nodes/${b.nodeId}`)).statusCode).toBe(409);

    // Rolling back with the source still to be started: blocked (the migration starts it).
    app.migrations.update(m.id, { phase: "rolling_back", target_pending: 1, source_pending: 1 });
    expect((await call("POST", `/api/servers/${s.id}/power`, { action: "start" })).json().error).toMatch(/rolled back/);
    // The target copy did get to start and has not been cleaned up: blocked even if the source is no longer pending.
    app.migrations.update(m.id, { source_pending: 0, target_started: 1 });
    expect((await call("POST", `/api/servers/${s.id}/power`, { action: "start" })).json().error).toMatch(/rolled back/);
    // I2: only a target that never started remains to be cleaned: the server is used on the source even if the target never comes back.
    app.migrations.update(m.id, { target_started: 0 });
    const usable = await call("POST", `/api/servers/${s.id}/power`, { action: "start" });
    expect(usable.json().error).toMatch(/offline/); // reaches the service (the test node is not connected)
    expect((await call("POST", "/api/servers", { nodeId: b.nodeId, name: "Nuevo", spec: {} })).statusCode).toBe(409); // the target, still dirty
    // And the target node can be deleted (escape hatch).
    expect((await call("DELETE", `/api/nodes/${b.nodeId}`)).statusCode).toBe(204);
    expect(app.migrations.get(m.id)).toBeNull(); // en cascada
    // Without a migration, the command reaches the service (the node is not connected).
    const r = await call("POST", `/api/servers/${s.id}/power`, { action: "start" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/offline/);
  });
});

describe("SyncSpecs", () => {
  it("does not remove from any node a server with an open migration going through it", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    let agent = new FakeAgent(url, b.nodeToken);
    await agent.connect({ specVersions: { [s.id]: 2n } }); // the target already holds the server (ghost)
    let sync = await agent.handshake();
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.removedIds).toEqual([]);
    expect(sync.body.value.servers).toEqual([]);
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(b.nodeId)).toBeUndefined());

    app.migrations.update(m.id, { phase: "failed" });
    agent = new FakeAgent(url, b.nodeToken);
    await agent.connect({ specVersions: { [s.id]: 2n } });
    sync = await agent.handshake();
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.removedIds).toEqual([s.id]);
    agent.close();
  });
});

describe("jobs", () => {
  it("migrate_in is an agent job: a panel restart does not mark it as interrupted; migrate does", () => {
    const rx = app.jobs.create({ type: "migrate_in", status: "running" });
    const mig = app.jobs.create({ type: "migrate", status: "running" });
    app.jobs.interruptStale();
    expect(app.jobs.get(rx.id)!.status).toBe("running");
    expect(app.jobs.get(mig.id)!.status).toBe("failed");
  });
});

describe("confirmed migration", () => {
  it("never goes back: neither undo nor reopen what is pending on the target", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.migrations.update(m.id, { target_touched: 1, target_started: 1 });
    expect(app.migrations.commit(m, "running", observed)).toBe(true);

    expect(app.migrations.startRollback(m.id, "late")).toBeNull(); // a failure after the commit does not undo
    expect(() => app.migrations.update(m.id, { phase: "rolling_back" })).toThrow(/already confirmed/);
    expect(() => app.migrations.update(m.id, { phase: "failed" })).toThrow(/already confirmed/);
    expect(() => app.migrations.update(m.id, { target_pending: 1 })).toThrow(/already confirmed/);
    expect(app.migrations.get(m.id)).toMatchObject({ phase: "committed", target_pending: 0, source_pending: 1 });
    app.migrations.update(m.id, { phase: "done", source_pending: 0 });
    expect(() => app.migrations.update(m.id, { phase: "rolling_back" })).toThrow(/already confirmed/);
    expect(app.migrations.interruptRunning("x")).toEqual([]);
    expect(app.migrations.get(m.id)!.phase).toBe("done");
  });

  it("startRollback only moves to rolling back what is still in progress, with what is pending according to what was done", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { was_running: 0 }));
    app.migrations.update(m.id, { target_touched: 1 });
    expect(app.migrations.startRollback(m.id, "Step 4: failed")).toMatchObject({
      phase: "rolling_back", target_pending: 1, source_pending: 0, error: "Step 4: failed",
    });
    expect(app.migrations.startRollback(m.id, "again")).toBeNull();
  });

  it("with the source removal pending, the slug cannot be reused on the source (MigrateRetire without spec)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    expect(app.migrations.commit(m, "running", observed)).toBe(true);
    expect(app.servers.getBySlug(a.nodeId, "uno")).toBeNull(); // in the table the slug is already free on the source…
    const call = (u: string, payload: object) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });
    // …but <DATA_ROOT>/uno is still there until MigrateRetire: creating with that slug on the source is rejected.
    const created = await call("/api/servers", { nodeId: a.nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/is part of a migration/);
    const t = (await call("/api/templates", { name: "Plantilla" })).json();
    const fromTemplate = await call(`/api/templates/${t.id}/servers`, { nodeId: a.nodeId, name: "Uno", slug: "uno" });
    expect(fromTemplate.statusCode).toBe(409);
    expect(app.servers.getBySlug(a.nodeId, "uno")).toBeNull();
    // Once the source is removed, the slug is available again.
    app.migrations.update(m.id, { phase: "done", source_pending: 0 });
    expect((await call("/api/servers", { nodeId: a.nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } })).statusCode).toBe(201);
  });

  it("a blocked upload receives the 409 as JSON", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    const r = await app.inject({
      method: "PUT", url: `/api/servers/${s.id}/files/upload?path=/x.txt`, headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(64 * 1024, 1),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/is being migrated/);
  });
});
