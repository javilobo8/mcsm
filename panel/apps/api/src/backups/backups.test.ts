import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { BackupTrigger, JobStatus, type BackupInfoSchema, type Envelope } from "@mcsm/proto";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;

const baseSpec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

async function enrollNode(name: string): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

const getBackups = async (serverId: string) => (await app.inject({ method: "GET", url: `/api/servers/${serverId}/backups`, headers: { cookie } })).json();

/** Espera el siguiente evento `name` que cumpla `pred`. Regístralo ANTES de provocarlo. */
function nextEvent(em: EventEmitter, name: string, pred: (...args: any[]) => boolean = () => true): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { em.off(name, h); reject(new Error(`sin evento ${name}`)); }, 3000);
    const h = (...args: any[]) => {
      if (!pred(...args)) return;
      clearTimeout(timer);
      em.off(name, h);
      resolve(args);
    };
    em.on(name, h);
  });
}

/** Conecta un agente falso, confirma el SyncSpecs (`ready`) y devuelve la petición de inventario que llega después. */
async function connectAgent(nodeToken: string, specVersions: Record<string, bigint> = {}) {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect({ specVersions });
  await agent.handshake();
  return { agent, list: await agent.waitFor("backupList") };
}

type InfoInit = MessageInitShape<typeof BackupInfoSchema>;
const T0 = 1_760_000_000_000n; // ms
const info = (serverId: string, filename: string, over: Partial<InfoInit> = {}): InfoInit => ({
  serverId, filename, sizeBytes: 1234n, sha256: "ab".repeat(32), specVersion: 1n, trigger: BackupTrigger.SCHEDULED,
  startedUnixMs: T0, finishedUnixMs: T0 + 5000n, ...over,
});

describe("inventario y avisos del agente", () => {
  it("un inventario cortado por una desconexión no es un aviso (se vuelve a pedir en el siguiente Hello)", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const warn = vi.spyOn(app.log, "warn");
    const info = vi.spyOn(app.log, "info");
    const { agent } = await connectAgent(nodeToken);
    agent.close();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.objectContaining({ nodeId }), expect.stringMatching(/inventario/)));
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/inventario/));
  });

  it("al conectar pide el inventario y lo refleja en copias y jobs", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    if (list.body.case !== "backupList") throw new Error();
    expect(list.body.value.serverId).toBe("");
    const changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: {
      serverIds: [s.id],
      backups: [
        info(s.id, "uno-20261012T040000.000Z-1.tar.zst"),
        info(s.id, "uno-20261012T050000.000Z-1.tar.zst", { startedUnixMs: T0 + 3_600_000n }),
        info(s.id, "data.pre-restore-20261012T060000.000Z", { trigger: BackupTrigger.PRE_RESTORE, sha256: "", startedUnixMs: T0 + 7_200_000n }),
      ],
      jobs: [{ jobId: "job-agente", serverId: s.id, type: "backup", status: JobStatus.OK, progress: 100, message: "Copia creada", log: "save-off\nsave-on\n", startedUnixMs: 1n, finishedUnixMs: 2n }],
    } } });
    await changed;
    const rows = await getBackups(s.id);
    expect(rows.map((b: any) => b.filename)).toEqual([
      "data.pre-restore-20261012T060000.000Z", "uno-20261012T050000.000Z-1.tar.zst", "uno-20261012T040000.000Z-1.tar.zst",
    ]);
    expect(rows[0]).toMatchObject({ trigger: "pre_restore", kind: "directory" });
    expect(rows[1]).toMatchObject({ trigger: "scheduled", kind: "archive", sizeBytes: 1234, status: "ok", specVersion: 1 });
    expect(app.jobs.get("job-agente")).toMatchObject({ type: "backup", serverId: s.id, status: "ok", progress: 100, log: "save-off\nsave-on\n" });
    agent.close();
  });

  it("marca borradas las copias que ya no están y da por perdidos los jobs abiertos que el agente no conoce", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    let { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { requestId: list.id, serverIds: [s.id], backups: [info(s.id, "uno-20261012T040000.000Z-1.tar.zst")], jobs: [] } } });
    await changed;
    expect(await getBackups(s.id)).toHaveLength(1);
    const lost = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" });
    agent.close();

    ({ agent, list } = await connectAgent(nodeToken, { [s.id]: 1n }));
    const late = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" }); // posterior a la petición
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { requestId: list.id, serverIds: [s.id], backups: [], jobs: [] } } });
    await changed;
    expect(await getBackups(s.id)).toEqual([]);
    expect(app.jobs.get(lost.id)).toMatchObject({ status: "failed", message: expect.stringMatching(/interrumpido/) });
    expect(app.jobs.get(late.id)!.status).toBe("running");
    agent.close();
  });

  it("un JobProgress desconocido crea el job programado; BackupCreated y BackupDeleted actualizan la lista", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const done = nextEvent(app.events, "job", (j) => j.id === "job-prog" && j.status === "ok");
    const progress = (status: JobStatus, extra: object) => ({ body: { case: "jobProgress" as const, value: { jobId: "job-prog", serverId: s.id, type: "backup", status, ...extra } } });
    agent.send(progress(JobStatus.RUNNING, { progress: 1, message: "Desactivando", logChunk: "save-off\n" }));
    agent.send({ body: { case: "backupCreated", value: { backup: info(s.id, "uno-20261012T040000.000Z-1.tar.zst"), jobId: "job-prog" } } });
    agent.send(progress(JobStatus.OK, { progress: 100, message: "Copia creada", logChunk: "save-on\n" }));
    await done;
    expect(app.jobs.get("job-prog")).toMatchObject({ type: "backup", serverId: s.id, nodeId, status: "ok", payload: { trigger: "scheduled" }, log: "save-off\nsave-on\n" });
    expect(await getBackups(s.id)).toHaveLength(1);
    const gone = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupDeleted", value: { serverId: s.id, filename: "uno-20261012T040000.000Z-1.tar.zst", reason: "poda" } } });
    await gone;
    expect(await getBackups(s.id)).toEqual([]);
    agent.close();
  });

  it("ignora avisos sobre servidores de otro nodo", async () => {
    const a = await enrollNode("a");
    const b = await enrollNode("b");
    const sa = app.servers.create({ nodeId: a.nodeId, name: "A", slug: "a", spec: baseSpec, desiredState: "running" });
    const sb = app.servers.create({ nodeId: b.nodeId, name: "B", slug: "b", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(a.nodeToken, { [sa.id]: 1n });
    agent.ack(list.id);
    const barrier = nextEvent(app.events, "backups", (id) => id === sa.id);
    agent.send({ body: { case: "backupCreated", value: { backup: info(sb.id, "b-20261012T040000.000Z-1.tar.zst") } } });
    agent.send({ body: { case: "jobProgress", value: { jobId: "ajeno", serverId: sb.id, type: "backup", status: JobStatus.RUNNING } } });
    agent.send({ body: { case: "backupCreated", value: { backup: info(sa.id, "a-20261012T040000.000Z-1.tar.zst") } } });
    await barrier;
    expect(await getBackups(sb.id)).toEqual([]);
    expect(app.jobs.get("ajeno")).toBeNull();
    agent.close();
  });
  it("es idempotente: un inventario repetido no falla por UNIQUE y no reabre un job terminal", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const rec = (status: JobStatus, message: string) => ({ jobId: "job-rep", serverId: s.id, type: "backup", status, progress: 100, message, log: "x\n", startedUnixMs: 1n, finishedUnixMs: 2n });
    const inv = (status: JobStatus, message: string) => ({ body: { case: "backupInventory" as const, value: { serverIds: [s.id], backups: [], jobs: [rec(status, message)] } } });
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send(inv(JobStatus.OK, "Copia creada"));
    await changed;
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send(inv(JobStatus.RUNNING, "otra vez")); // repetido y tardío
    await changed;
    expect(app.jobs.get("job-rep")).toMatchObject({ status: "ok", message: "Copia creada" });
    agent.close();
  });

  it("server_ids vacío significa ninguno: no borra ni inserta copias", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupCreated", value: { backup: info(s.id, "uno-20261012T040000.000Z-1.tar.zst") } } });
    await changed;
    const barrier = nextEvent(app.events, "job", (j) => j.id === "barrera");
    agent.send({ body: { case: "backupInventory", value: { serverIds: [], backups: [info(s.id, "otra.tar.zst")], jobs: [] } } });
    agent.send({ body: { case: "jobProgress", value: { jobId: "barrera", serverId: s.id, type: "backup", status: JobStatus.RUNNING } } });
    await barrier;
    expect((await getBackups(s.id)).map((b: any) => b.filename)).toEqual(["uno-20261012T040000.000Z-1.tar.zst"]);
    agent.close();
  });

  it("la petición de inventario espera al Ack de SyncSpecs y pide todos los servidores", async () => {
    const { nodeToken } = await enrollNode("nas");
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({});
    const sync = await agent.waitFor("syncSpecs");
    await expect(agent.waitFor("backupList", 200)).rejects.toThrow(); // retenida hasta ready
    agent.ack(sync.id);
    const l = await agent.waitFor("backupList");
    if (l.body.case !== "backupList") throw new Error();
    expect(l.body.value.serverId).toBe("");
    agent.close();
  });

  it("m2: una copia anunciada después de pedir el inventario no se marca borrada aunque el inventario no la traiga", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupCreated", value: { backup: info(s.id, "uno-20261012T040000.000Z-1.tar.zst") } } });
    await changed;
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { requestId: list.id, serverIds: [s.id], backups: [], jobs: [] } } }); // calculado antes
    await changed;
    expect((await getBackups(s.id)).map((b: any) => b.filename)).toEqual(["uno-20261012T040000.000Z-1.tar.zst"]);
    agent.close();
  });

  it("M1: un inventario que no contesta al último BackupList de la sesión vigente (anterior o periódico) solo aplica lo positivo", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const kept = "uno-20261012T040000.000Z-1.tar.zst";
    let { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    const firstList = list.id;
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { requestId: list.id, serverIds: [s.id], backups: [info(s.id, kept)], jobs: [] } } });
    await changed;
    // Sesión 1: el usuario pide una restauración y el agente la empieza; luego el enlace se cae.
    const live = app.jobs.create({ type: "restore", serverId: s.id, nodeId, status: "running" });
    agent.close();

    // Sesión 2: la cola del agente entrega inventarios calculados antes de la restauración.
    ({ agent, list } = await connectAgent(nodeToken, { [s.id]: 1n }));
    expect(list.id).not.toBe(firstList); // los ids no se repiten entre sesiones
    agent.ack(list.id);
    const fresh = "uno-20261012T050000.000Z-1.tar.zst";
    for (const requestId of [firstList, 0n]) {
      changed = nextEvent(app.events, "backups", (id) => id === s.id);
      agent.send({ body: { case: "backupInventory", value: { requestId, serverIds: [s.id], backups: [info(s.id, fresh)], jobs: [] } } });
      await changed;
      expect(app.jobs.get(live.id)).toMatchObject({ status: "running" });
      // Lo positivo sí: la copia nueva aparece y la que falta no se da por borrada.
      expect((await getBackups(s.id)).map((b: any) => b.filename).sort()).toEqual([kept, fresh]);
    }

    // El que contesta al BackupList vigente sí aplica la vía negativa.
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupInventory", value: { requestId: list.id, serverIds: [s.id], backups: [info(s.id, fresh)], jobs: [] } } });
    await changed;
    expect(app.jobs.get(live.id)).toMatchObject({ status: "failed", message: expect.stringMatching(/interrumpido/) });
    expect((await getBackups(s.id)).map((b: any) => b.filename)).toEqual([fresh]);
    agent.close();
  });

  it("inventario periódico (sin petición): cierra un job cuyo aviso terminal se perdió sin tocar copias nuevas ni el log de un job en curso", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    let changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], backups: [], jobs: [] } } });
    await changed;
    const stuck = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" }); // su OK se descartó
    const live = app.jobs.create({ type: "restore", serverId: s.id, nodeId, status: "running" });
    app.jobs.update(live.id, { logChunk: "cabecera\n" });
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupCreated", value: { backup: info(s.id, "uno-20261012T040000.000Z-1.tar.zst") } } });
    await changed;
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], backups: [], jobs: [
      { jobId: stuck.id, serverId: s.id, type: "backup", status: JobStatus.OK, progress: 100, message: "Copia creada", log: "fin\n", startedUnixMs: 1n, finishedUnixMs: 2n },
      { jobId: live.id, serverId: s.id, type: "restore", status: JobStatus.RUNNING, progress: 40, message: "Extrayendo", log: "cola\n", startedUnixMs: 1n },
    ] } } });
    await changed;
    expect(app.jobs.get(stuck.id)).toMatchObject({ status: "ok", message: "Copia creada" });
    expect(app.jobs.get(live.id)).toMatchObject({ status: "running", progress: 40, log: "cabecera\n" });
    expect((await getBackups(s.id)).map((b: any) => b.filename)).toEqual(["uno-20261012T040000.000Z-1.tar.zst"]);
    agent.close();
  });

  it("GET /backups de un servidor inexistente devuelve 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/servers/nope/backups", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("acciones sobre copias", () => {
  const post = (u: string) => app.inject({ method: "POST", url: u, headers: { cookie } });

  async function setup() {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const s = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    return { nodeId, nodeToken, s };
  }

  it("sin sesión: crear, restaurar, borrar y programar responden 401 y no tocan nada", async () => {
    const { s } = await setup();
    const b = app.backupsService["repo"].upsertOk(s.node_id, {
      serverId: s.id, filename: "uno-20261012T040000.000Z-1.tar.zst", sizeBytes: 1, sha256: "", specVersion: 1,
      trigger: "manual", startedAt: new Date().toISOString(), finishedAt: null,
    });
    const reqs = [
      { method: "POST" as const, url: `/api/servers/${s.id}/backups` },
      { method: "POST" as const, url: `/api/servers/${s.id}/backups/${b.id}/restore` },
      { method: "DELETE" as const, url: `/api/servers/${s.id}/backups/${b.id}` },
      { method: "PATCH" as const, url: `/api/servers/${s.id}/backups/schedule`, payload: { enabled: true, cron: "0 4 * * *" } },
    ];
    for (const r of reqs) {
      expect((await app.inject(r)).statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    expect(app.backupsService["repo"].get(b.id)!.status).toBe("ok");
    expect(app.jobs.list({})).toEqual([]);
  });

  it("crear copia: 409 con el nodo desconectado; conectado envía BackupNow y devuelve el job", async () => {
    const { nodeToken, s } = await setup();
    let res = await post(`/api/servers/${s.id}/backups`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desconectado/);
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const pending = post(`/api/servers/${s.id}/backups`);
    const req = await agent.waitFor("backupNow");
    if (req.body.case !== "backupNow") throw new Error();
    expect(req.body.value).toMatchObject({ serverId: s.id, trigger: BackupTrigger.MANUAL });
    const jobId = req.body.value.jobId;
    agent.ack(req.id);
    res = await pending;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: jobId, type: "backup", status: "running", serverId: s.id, payload: { trigger: "manual" } });
    const done = nextEvent(app.events, "job", (j) => j.id === jobId && j.status === "ok");
    agent.send({ body: { case: "backupCreated", value: { backup: info(s.id, "uno-20261012T040000.000Z-1.tar.zst", { trigger: BackupTrigger.MANUAL }), jobId } } });
    agent.send({ body: { case: "jobProgress", value: { jobId, serverId: s.id, type: "backup", status: JobStatus.OK, progress: 100, message: "Copia creada" } } });
    await done;
    expect((await getBackups(s.id))[0]).toMatchObject({ trigger: "manual", kind: "archive" });
    agent.close();
  });

  it("si el agente responde busy: 409 y el job queda fallido", async () => {
    const { nodeToken, s } = await setup();
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const pending = post(`/api/servers/${s.id}/backups`);
    const req = await agent.waitFor("backupNow");
    agent.send({ id: req.id, body: { case: "error", value: { code: "busy", message: "el servidor está ocupado con otra copia o restauración (restauración)" } } });
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/ocupado/);
    expect(app.jobs.list({ serverId: s.id })[0]).toMatchObject({ status: "failed", message: expect.stringMatching(/ocupado/) });
    agent.close();
  });

  it("restaurar envía el nombre del fichero; los datos pre-restore no se restauran; borrar marca la copia", async () => {
    const { nodeToken, s } = await setup();
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    const synced = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], jobs: [], backups: [
      info(s.id, "uno-20261012T040000.000Z-1.tar.zst"),
      info(s.id, "data.pre-restore-20261012T060000.000Z", { trigger: BackupTrigger.PRE_RESTORE, sha256: "" }),
    ] } } });
    await synced;
    const rows = await getBackups(s.id);
    const archive = rows.find((b: any) => b.kind === "archive");
    const dir = rows.find((b: any) => b.kind === "directory");
    let res = await post(`/api/servers/${s.id}/backups/${dir.id}/restore`);
    expect(res.statusCode).toBe(400);

    const pending = post(`/api/servers/${s.id}/backups/${archive.id}/restore`);
    const req = await agent.waitFor("backupRestore");
    if (req.body.case !== "backupRestore") throw new Error();
    expect(req.body.value).toMatchObject({ serverId: s.id, filename: archive.filename });
    agent.ack(req.id);
    res = await pending;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ type: "restore", status: "running", payload: { backupId: archive.id, filename: archive.filename } });

    const del = app.inject({ method: "DELETE", url: `/api/servers/${s.id}/backups/${dir.id}`, headers: { cookie } });
    const dreq = await agent.waitFor("backupDelete");
    if (dreq.body.case !== "backupDelete") throw new Error();
    expect(dreq.body.value.filename).toBe(dir.filename);
    agent.ack(dreq.id);
    expect((await del).statusCode).toBe(204);
    expect((await getBackups(s.id)).map((b: any) => b.id)).toEqual([archive.id]);
    expect((await post(`/api/servers/${s.id}/backups/${dir.id}/restore`)).statusCode).toBe(404);
    agent.close();
  });

  it("la programación se valida, versiona la spec, llega al agente y el formulario de configuración no la borra", async () => {
    const { nodeToken, s } = await setup();
    const patch = (u: string, payload: object) => app.inject({ method: "PATCH", url: u, headers: { cookie }, payload });
    let res = await patch(`/api/servers/${s.id}/backups/schedule`, { enabled: true, cron: "0 4 * * MON" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Día de la semana/);
    res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}/backups/schedule`, headers: { cookie } });
    expect(res.statusCode).toBe(400);

    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const pending = patch(`/api/servers/${s.id}/backups/schedule`, { enabled: true, cron: "0 */6 * * *", keepCount: 5 });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    const sent = JSON.parse(new TextDecoder().decode(apply.body.value.server!.specJson));
    expect(sent.backups).toMatchObject({ enabled: true, cron: "0 */6 * * *", keepCount: 5 });
    agent.ack(apply.id);
    res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { backups: { enabled: true, cron: "0 */6 * * *", keepCount: 5, keepDays: 7, excludes: ["logs", "cache", "*.tmp"], onlyIfPlayersSince: true } } });

    const form = patch(`/api/servers/${s.id}`, { spec: { memory: "3G" } }); // el formulario no envía backups
    agent.ack((await agent.waitFor("applySpec")).id);
    res = await form;
    expect(res.json()).toMatchObject({ specVersion: 3, spec: { memory: "3G", backups: { cron: "0 */6 * * *" } } });
    agent.close();
  });
  it("la programación pasa por el PATCH de la spec: sin cambios no versiona y los errores llevan la ruta del campo", async () => {
    const { s } = await setup();
    const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/servers/${s.id}/backups/schedule`, headers: { cookie }, payload });
    let res = await patch({ enabled: true, cron: "0 4 * * *" });
    expect(res.json()).toMatchObject({ specVersion: 2 });
    res = await patch({ enabled: true, cron: "0 4 * * *" }); // los mismos valores (con sus defectos): nada que aplicar
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { backups: { enabled: true, cron: "0 4 * * *" } } });
    expect(app.servers.get(s.id)!.spec_version).toBe(2);
    res = await patch({ enabled: true, cron: "0 4 * * MON" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^backups\.cron: /);
    expect(app.servers.get(s.id)!.spec_version).toBe(2);
  });

  it("PATCH de la spec: backups null borra la programación y llega al agente sin la sección; ausente se conserva", async () => {
    const { nodeToken, s } = await setup();
    const patch = (u: string, payload: object) => app.inject({ method: "PATCH", url: u, headers: { cookie }, payload });
    let res = await patch(`/api/servers/${s.id}/backups/schedule`, { enabled: true, cron: "0 4 * * *" });
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { backups: { enabled: true, cron: "0 4 * * *" } } });
    res = await patch(`/api/servers/${s.id}`, { spec: { memory: "3G" } }); // sin la clave: se conserva
    expect(res.json()).toMatchObject({ specVersion: 3, spec: { memory: "3G", backups: { enabled: true, cron: "0 4 * * *" } } });

    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 3n });
    agent.ack(list.id);
    const pending = patch(`/api/servers/${s.id}`, { spec: { backups: null } });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(apply.body.value.server!.version).toBe(4n);
    expect(JSON.parse(new TextDecoder().decode(apply.body.value.server!.specJson))).not.toHaveProperty("backups");
    agent.ack(apply.id);
    res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().specVersion).toBe(4);
    expect(res.json().spec).not.toHaveProperty("backups");
    expect(JSON.parse(app.servers.get(s.id)!.spec)).not.toHaveProperty("backups");
    agent.close();
  });
  it("una copia de otro servidor es 404 al restaurar y al borrar", async () => {
    const { nodeId, nodeToken, s } = await setup();
    const other = app.servers.create({ nodeId, name: "Dos", slug: "dos", spec: baseSpec, desiredState: "running" });
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n, [other.id]: 1n });
    const synced = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], jobs: [], backups: [info(s.id, "uno-20261012T040000.000Z-1.tar.zst")] } } });
    await synced;
    const b = (await getBackups(s.id))[0];
    expect((await post(`/api/servers/${other.id}/backups/${b.id}/restore`)).statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: `/api/servers/${other.id}/backups/${b.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(404);
    agent.close();
  });

  it("errores del agente al restaurar y al borrar: restaurar deja el job fallido; borrar conserva la copia", async () => {
    const { nodeToken, s } = await setup();
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    const synced = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], jobs: [], backups: [info(s.id, "uno-20261012T040000.000Z-1.tar.zst")] } } });
    await synced;
    const b = (await getBackups(s.id))[0];
    const r = post(`/api/servers/${s.id}/backups/${b.id}/restore`);
    const rreq = await agent.waitFor("backupRestore");
    agent.send({ id: rreq.id, body: { case: "error", value: { code: "busy", message: "ocupado con otra copia" } } });
    const rres = await r;
    expect(rres.statusCode).toBe(409);
    expect(app.jobs.list({ serverId: s.id })[0]).toMatchObject({ type: "restore", status: "failed" });
    const d = app.inject({ method: "DELETE", url: `/api/servers/${s.id}/backups/${b.id}`, headers: { cookie } });
    const dreq = await agent.waitFor("backupDelete");
    agent.send({ id: dreq.id, body: { case: "error", value: { code: "not_found", message: "no existe la copia" } } });
    expect((await d).statusCode).toBe(404);
    expect((await getBackups(s.id)).map((x: any) => x.id)).toEqual([b.id]);
    agent.close();
  });

  it("la programación con el nodo desconectado se guarda y versiona sin 409", async () => {
    const { s } = await setup();
    const res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}/backups/schedule`, headers: { cookie }, payload: { enabled: true, cron: "0 4 * * *" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ specVersion: 2, spec: { backups: { enabled: true, cron: "0 4 * * *" } } });
  });

  it("si la conexión cae sin respuesta el job sigue abierto; el inventario posterior lo cierra", async () => {
    const { nodeToken, s } = await setup();
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const pending = post(`/api/servers/${s.id}/backups`);
    await agent.waitFor("backupNow");
    agent.close(); // sin Ack
    const res = await pending;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ type: "backup", status: "running" });
    expect(app.jobs.list({ serverId: s.id })[0]).toMatchObject({ status: "running" });
  });

  it("Idempotency-Key: un reintento devuelve el mismo job y no envía otra orden", async () => {
    const { nodeToken, s } = await setup();
    const { agent, list } = await connectAgent(nodeToken, { [s.id]: 1n });
    agent.ack(list.id);
    const send = () => app.inject({ method: "POST", url: `/api/servers/${s.id}/backups`, headers: { cookie, "idempotency-key": "k1" } });
    const first = send();
    agent.ack((await agent.waitFor("backupNow")).id);
    const a = await first;
    const b = await send();
    expect(b.statusCode).toBe(202);
    expect(b.json().id).toBe(a.json().id);
    expect(app.jobs.list({ serverId: s.id })).toHaveLength(1);
    agent.close();
  });
});
