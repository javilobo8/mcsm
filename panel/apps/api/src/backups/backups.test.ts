import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], backups: [info(s.id, "uno-20261012T040000.000Z-1.tar.zst")], jobs: [] } } });
    await changed;
    expect(await getBackups(s.id)).toHaveLength(1);
    const lost = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" });
    agent.close();

    ({ agent, list } = await connectAgent(nodeToken, { [s.id]: 1n }));
    const late = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" }); // posterior a la petición
    changed = nextEvent(app.events, "backups", (id) => id === s.id);
    agent.ack(list.id);
    agent.send({ body: { case: "backupInventory", value: { serverIds: [s.id], backups: [], jobs: [] } } });
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

  it("GET /backups de un servidor inexistente devuelve 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/servers/nope/backups", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
