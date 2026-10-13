import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { JobStatus } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { agentIso } from "./service.js";

let app: FastifyInstance; let url: string; let cookie: string; let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const connectAgent = async () => {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  agent.ack((await agent.waitFor("backupList")).id);
  return agent;
};
const createServer = async () => (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
const job = async (id: string) => (await app.inject({ method: "GET", url: `/api/jobs/${id}`, headers: { cookie } })).json();

describe("copias y jobs (Plan 9)", () => {
  it("agentIso: acepta horas razonables del agente", () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    expect(agentIso(BigInt(now - 3_600_000), now)).toBe("2026-10-13T11:00:00.000Z");
    expect(agentIso(0n, now)).toBeNull();
    expect(agentIso(BigInt(now + 60_000), now)).toBeNull(); // más de 45 s en el futuro
    expect(agentIso(BigInt(now - 40 * 86_400_000), now)).toBeNull();
  });

  it("un job programado que llega por el inventario conserva las horas del agente en started/finished (created_at es del panel)", async () => {
    const s = await createServer();
    const agent = await connectAgent();
    const started = Date.now() - 2 * 3_600_000;
    agent.send({ body: { case: "backupInventory", value: {
      serverIds: [s.id], backups: [], requestId: 0n,
      jobs: [{ jobId: "job-sched", serverId: s.id, type: "backup", status: JobStatus.OK, progress: 100, message: "Copia creada", log: "",
        startedUnixMs: BigInt(started), finishedUnixMs: BigInt(started + 5_000) }],
    } } });
    await vi.waitFor(async () => expect((await job("job-sched")).status).toBe("ok"));
    expect(await job("job-sched")).toMatchObject({
      startedAt: new Date(started).toISOString(), finishedAt: new Date(started + 5_000).toISOString(),
    });
    agent.close();
  });

  it("el JobProgress de un agente no toca un job que no es suyo (migrate)", async () => {
    const s = await createServer();
    const agent = await connectAgent();
    const mig = app.jobs.create({ type: "migrate", serverId: s.id, nodeId, status: "running", message: "migrando" });
    agent.send({ body: { case: "jobProgress", value: { jobId: mig.id, serverId: s.id, type: "backup", status: JobStatus.OK, progress: 100, message: "x", tsUnixMs: BigInt(Date.now()) } } });
    // Un aviso posterior que sí es suyo marca el orden: cuando se ha procesado, el anterior también.
    agent.send({ body: { case: "jobProgress", value: { jobId: "propio", serverId: s.id, type: "backup", status: JobStatus.RUNNING, progress: 1, message: "y", tsUnixMs: BigInt(Date.now()) } } });
    await vi.waitFor(async () => expect((await job("propio")).status).toBe("running"));
    expect(await job(mig.id)).toMatchObject({ status: "running", message: "migrando" });
    agent.close();
  });

  it("syncAll pide el inventario a cada nodo conectado", async () => {
    const agent = await connectAgent();
    app.backupsService.syncAll();
    const list = await agent.waitFor("backupList");
    expect(list.body.case).toBe("backupList");
    agent.ack(list.id);
    agent.close();
  });
});
