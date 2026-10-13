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
  it("commit: mueve la fila solo si sigue en el origen con la misma versión y sin romper el slug único", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m1 = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.servers.bumpVersion(s.id); // la spec cambió durante la migración
    expect(app.migrations.commit(m1, "running", observed)).toBe(false);
    expect(app.servers.get(s.id)!.node_id).toBe(a.nodeId);
    expect(app.migrations.get(m1.id)!.phase).toBe("running");

    const m2 = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, {
      source_version: 2, target_version: 3, target_port: 25570, target_spec: JSON.stringify(spec(25570)),
    }));
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "uno", spec: spec(25580), desiredState: "stopped" });
    expect(app.migrations.commit(m2, "running", observed)).toBe(false); // slug ocupado en el destino
    app.servers.delete(other.id);

    expect(app.migrations.commit(m2, "stopped", observed)).toBe(true);
    const row = app.servers.get(s.id)!;
    expect(row).toMatchObject({ node_id: b.nodeId, slug: "uno", spec_version: 3, desired_state: "stopped", observed_spec_version: 3 });
    expect(row.desired_changed_at).not.toBeNull(); // el commit cambia el estado deseado: marca la hora (un crash_loop atrasado no lo deshace)
    expect(JSON.parse(row.spec).ports.game).toBe(25570);
    expect(JSON.parse(row.observed!).containerId).toBe("c1");
    expect(app.migrations.get(m2.id)).toMatchObject({ phase: "committed", source_pending: 1 });
  });

  it("commit: un servidor importado (imported_from, Plan 6) deja de seguir a su contenedor original", async () => {
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

  it("commit fallido: un importado sigue con su imported_from en el origen", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    app.servers.setImportedFrom(s.id, {
      containerId: "c".repeat(64), containerName: "mc-viejo", specVersion: 1, importedAt: "2026-10-12T00:00:00.000Z", composeProject: "", composeService: "",
    });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.servers.bumpVersion(s.id); // la spec cambió durante la migración: el commit no mueve nada
    expect(app.migrations.commit(m, "running", null)).toBe(false);
    expect(app.servers.get(s.id)).toMatchObject({ node_id: a.nodeId });
    expect(app.servers.get(s.id)!.imported_from).toMatch(/mc-viejo/);
  });

  it("commit: falla si otro servidor del destino ya usa el puerto de juego o un puerto extra (M1)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { target_port: 25570, target_spec: JSON.stringify(spec(25570)) }));
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "otro", spec: spec(25571), desiredState: "stopped" });
    // Alguien cambió el otro servidor de B para usar el puerto reservado (sin pasar por checkPorts).
    app.servers.updateSpec(other.id, spec(25570));
    expect(app.migrations.commit(m, "running", observed)).toBe(false);
    expect(app.servers.get(s.id)!.node_id).toBe(a.nodeId);
    expect(app.migrations.get(m.id)!.phase).toBe("running");
    app.servers.updateSpec(other.id, specSchema.parse({ ...spec(25572), ports: { game: 25572, extra: [{ host: 25570, container: 19132, proto: "udp" }] } }));
    expect(app.migrations.commit(m, "running", observed)).toBe(false);
    app.servers.updateSpec(other.id, spec(25572));
    expect(app.migrations.commit(m, "running", observed)).toBe(true);
  });

  it("checkPorts y allocatePort cuentan los puertos reservados por migraciones hacia el nodo (M1)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const other = app.servers.create({ nodeId: b.nodeId, name: "Otro", slug: "otro", spec: spec(25571), desiredState: "stopped" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { target_port: 25566, target_spec: JSON.stringify(spec(25566)) }));
    const patch = await app.inject({ method: "PATCH", url: `/api/servers/${other.id}`, headers: { cookie }, payload: { spec: { ports: { game: 25566 } } } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error).toMatch(/25566/);
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25565);
    app.servers.updateSpec(other.id, spec(25565));
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25567); // 25566 lo reserva la migración
    app.migrations.update(m.id, { phase: "failed" });
    expect(app.serversService.allocatePort(b.nodeId)).toBe(25566);
  });

  it("blockingServer y blockingNodeCreate solo mientras puede haber conflicto (I2)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    const cases: [Parameters<typeof app.migrations.update>[1], boolean, boolean][] = [
      // patch, bloquea el servidor, bloquea crear en el destino
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

  it("interruptRunning, protects y las consultas de bloqueo", async () => {
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
    expect(app.migrations.blockingServer(s2.id)).toBeNull(); // confirmada: el servidor ya es libre
    expect(app.migrations.blockingNodeCreate(b.nodeId)?.id).toBe(run.id);
    expect(app.migrations.blockingNodeCreate(c.nodeId)?.id).toBe(com.id); // origen pendiente de retirar
    expect(app.migrations.blockingNodeDelete(b.nodeId)?.id).toBe(run.id);
    expect(app.migrations.blockingNodeDelete(c.nodeId)).toBeNull();

    const out = app.migrations.interruptRunning("interrumpido");
    expect(out.map((r) => r.id)).toEqual([run.id]);
    expect(app.migrations.get(run.id)).toMatchObject({ phase: "rolling_back", target_pending: 1, source_pending: 1, target_started: 1, error: "interrumpido" });
    expect(app.migrations.get(com.id)!.phase).toBe("committed");
    expect(app.migrations.listOpen().map((r) => r.id).sort()).toEqual([run.id, com.id].sort());
    expect(app.migrations.blockingNodeDelete(b.nodeId)).toBeNull(); // deshaciéndose: el destino se puede borrar
    app.migrations.update(run.id, { phase: "failed", target_pending: 0, source_pending: 0 });
    expect(app.migrations.protects(b.nodeId, s.id)).toBe(false);
    expect(app.migrations.latestForServer(s.id)?.phase).toBe("failed");
    expect(app.migrations.openForServer(s.id)).toBeNull();
  });
});

describe("guarda de acciones", () => {
  it("bloquea lo que cambia el servidor o los nodos mientras dura; las lecturas siguen", async () => {
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
      expect(r.json().error).toMatch(/«Uno» se está migrando/);
    }
    expect((await call("GET", `/api/servers/${s.id}`)).statusCode).toBe(200);
    const create = await call("POST", "/api/servers", { nodeId: b.nodeId, name: "Nuevo", spec: {} });
    expect(create.statusCode).toBe(409);
    expect(create.json().error).toMatch(/participa en una migración/);
    // Plan 6: importar un contenedor en el nodo destino también crea allí un servidor (la guarda corre antes que la ruta).
    const imported = await call("POST", `/api/nodes/${b.nodeId}/import`, { containerId: "c".repeat(64), name: "Importado", spec: {}, applyNow: false });
    expect(imported.statusCode).toBe(409);
    expect(imported.json().error).toMatch(/participa en una migración/);
    expect((await call("DELETE", `/api/nodes/${b.nodeId}`)).statusCode).toBe(409);

    // Deshaciéndose con el origen aún por arrancar: bloqueado (lo arranca la migración).
    app.migrations.update(m.id, { phase: "rolling_back", target_pending: 1, source_pending: 1 });
    expect((await call("POST", `/api/servers/${s.id}/power`, { action: "start" })).json().error).toMatch(/deshaciendo/);
    // La copia del destino llegó a arrancar y no se ha limpiado: bloqueado aunque el origen ya no esté pendiente.
    app.migrations.update(m.id, { source_pending: 0, target_started: 1 });
    expect((await call("POST", `/api/servers/${s.id}/power`, { action: "start" })).json().error).toMatch(/deshaciendo/);
    // I2: solo falta limpiar un destino que nunca arrancó: el servidor se usa en el origen aunque el destino no vuelva.
    app.migrations.update(m.id, { target_started: 0 });
    const usable = await call("POST", `/api/servers/${s.id}/power`, { action: "start" });
    expect(usable.json().error).toMatch(/desconectado/); // llega al servicio (el nodo de pruebas no está conectado)
    expect((await call("POST", "/api/servers", { nodeId: b.nodeId, name: "Nuevo", spec: {} })).statusCode).toBe(409); // el destino, aún sucio
    // Y el nodo destino se puede borrar (escapatoria).
    expect((await call("DELETE", `/api/nodes/${b.nodeId}`)).statusCode).toBe(204);
    expect(app.migrations.get(m.id)).toBeNull(); // en cascada
    // Sin migración, la orden llega al servicio (el nodo no está conectado).
    const r = await call("POST", `/api/servers/${s.id}/power`, { action: "start" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/desconectado/);
  });
});

describe("SyncSpecs", () => {
  it("no retira de ningún nodo un servidor con una migración abierta que pasa por él", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    let agent = new FakeAgent(url, b.nodeToken);
    await agent.connect({ specVersions: { [s.id]: 2n } }); // el destino ya guarda el servidor (fantasma)
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
  it("migrate_in es un job del agente: un reinicio del panel no lo da por interrumpido; migrate sí", () => {
    const rx = app.jobs.create({ type: "migrate_in", status: "running" });
    const mig = app.jobs.create({ type: "migrate", status: "running" });
    app.jobs.interruptStale();
    expect(app.jobs.get(rx.id)!.status).toBe("running");
    expect(app.jobs.get(mig.id)!.status).toBe("failed");
  });
});

describe("migración confirmada", () => {
  it("nunca vuelve atrás: ni deshacer ni reabrir lo pendiente del destino", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    app.migrations.update(m.id, { target_touched: 1, target_started: 1 });
    expect(app.migrations.commit(m, "running", observed)).toBe(true);

    expect(app.migrations.startRollback(m.id, "tarde")).toBeNull(); // un fallo tras el commit no deshace
    expect(() => app.migrations.update(m.id, { phase: "rolling_back" })).toThrow(/ya confirmada/);
    expect(() => app.migrations.update(m.id, { phase: "failed" })).toThrow(/ya confirmada/);
    expect(() => app.migrations.update(m.id, { target_pending: 1 })).toThrow(/ya confirmada/);
    expect(app.migrations.get(m.id)).toMatchObject({ phase: "committed", target_pending: 0, source_pending: 1 });
    app.migrations.update(m.id, { phase: "done", source_pending: 0 });
    expect(() => app.migrations.update(m.id, { phase: "rolling_back" })).toThrow(/ya confirmada/);
    expect(app.migrations.interruptRunning("x")).toEqual([]);
    expect(app.migrations.get(m.id)!.phase).toBe("done");
  });

  it("startRollback solo pasa a deshacerse lo que sigue en curso, con lo pendiente según lo hecho", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId, { was_running: 0 }));
    app.migrations.update(m.id, { target_touched: 1 });
    expect(app.migrations.startRollback(m.id, "Paso 4: falló")).toMatchObject({
      phase: "rolling_back", target_pending: 1, source_pending: 0, error: "Paso 4: falló",
    });
    expect(app.migrations.startRollback(m.id, "otra vez")).toBeNull();
  });

  it("con la retirada del origen pendiente, el slug no se puede reutilizar en el origen (MigrateRetire sin spec)", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    const m = app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    expect(app.migrations.commit(m, "running", observed)).toBe(true);
    expect(app.servers.getBySlug(a.nodeId, "uno")).toBeNull(); // en la tabla el slug ya está libre en el origen…
    const call = (u: string, payload: object) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });
    // …pero <DATA_ROOT>/uno sigue allí hasta MigrateRetire: crear con ese slug en el origen se rechaza.
    const created = await call("/api/servers", { nodeId: a.nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/participa en una migración/);
    const t = (await call("/api/templates", { name: "Plantilla" })).json();
    const fromTemplate = await call(`/api/templates/${t.id}/servers`, { nodeId: a.nodeId, name: "Uno", slug: "uno" });
    expect(fromTemplate.statusCode).toBe(409);
    expect(app.servers.getBySlug(a.nodeId, "uno")).toBeNull();
    // Retirado el origen, el slug vuelve a estar disponible.
    app.migrations.update(m.id, { phase: "done", source_pending: 0 });
    expect((await call("/api/servers", { nodeId: a.nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } })).statusCode).toBe(201);
  });

  it("una subida bloqueada recibe el 409 en JSON", async () => {
    const a = await enroll("a"); const b = await enroll("b");
    const s = app.servers.create({ nodeId: a.nodeId, name: "Uno", slug: "uno", spec: spec(25565), desiredState: "running" });
    app.migrations.insert(newMigration(s.id, a.nodeId, b.nodeId));
    const r = await app.inject({
      method: "PUT", url: `/api/servers/${s.id}/files/upload?path=/x.txt`, headers: { cookie, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(64 * 1024, 1),
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/se está migrando/);
  });
});
