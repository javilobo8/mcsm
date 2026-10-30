import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { JobStatus, type Envelope } from "@mcsm/proto";
import { specSchema, type BackupFirstAccepted, type Spec } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;

const baseSpec = specSchema.parse({
  type: "FABRIC", version: "1.21.1", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh",
  mods: { modrinthProjects: ["AANobbMI:SodVer01"] },
});

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

async function enrollNode(name: string): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

/** A node with one server and, unless `online` is false, a connected fake agent that has synced and listed backups. */
async function setup(online = true) {
  const { nodeId, nodeToken } = await enrollNode("nas");
  const s = app.servers.create({ nodeId, name: "One", slug: "one", spec: baseSpec, desiredState: "running" });
  if (!online) return { nodeId, s, agent: null };
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect({ specVersions: { [s.id]: 1n } });
  await agent.handshake();
  agent.ack((await agent.waitFor("backupList")).id);
  return { nodeId, s, agent };
}

const patch = (id: string, body: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: body as object });
const server = (id: string) => { const r = app.servers.get(id)!; return { specVersion: r.spec_version, spec: JSON.parse(r.spec) as Spec }; };
const job = (id: string) => app.jobs.get(id)!;
const progress = (req: Envelope, status: JobStatus) => {
  if (req.body.case !== "backupNow") throw new Error("not a backupNow");
  return { body: { case: "jobProgress" as const, value: { jobId: req.body.value.jobId, serverId: req.body.value.serverId, type: "backup", status, progress: 100, message: "done" } } };
};
const backupJobId = (req: Envelope) => { if (req.body.case !== "backupNow") throw new Error("not a backupNow"); return req.body.value.jobId; };

/** PATCH with backupFirst: the agent confirms the BackupNow; returns the 202 body and the request. */
async function backupFirst(agent: FakeAgent, id: string, body: object) {
  const pending = patch(id, { ...body, backupFirst: true });
  const req = await agent.waitFor("backupNow");
  agent.ack(req.id);
  const res = await pending;
  expect(res.statusCode).toBe(202);
  return { jobId: (res.json() as BackupFirstAccepted).jobId, req };
}

describe("PATCH /api/servers/:id with backupFirst", () => {
  it("applies the change only after the backup succeeds", async () => {
    const { s, agent } = await setup();
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    expect(job(jobId)).toMatchObject({
      type: "spec_apply", serverId: s.id, status: "running", message: "Waiting for the backup before applying the change",
      payload: { backupJobId: backupJobId(req), baseVersion: 1, patch: { spec: { mods: null } } },
    });
    expect(server(s.id).specVersion).toBe(1); // not yet
    agent!.send(progress(req, JobStatus.OK));
    await vi.waitFor(() => expect(job(jobId).status).toBe("ok"));
    expect(server(s.id).specVersion).toBe(2);
    expect(server(s.id).spec.mods).toBeUndefined();
    expect(job(jobId).message).toBe("Backup done; change applied (v2)");
    agent!.close();
  });

  it("leaves the spec untouched when the backup fails", async () => {
    const { s, agent } = await setup();
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    agent!.send(progress(req, JobStatus.FAILED));
    await vi.waitFor(() => expect(job(jobId).status).toBe("failed"));
    expect(job(jobId).message).toBe("The backup failed: the change was not applied");
    expect(server(s.id).specVersion).toBe(1);
    agent!.close();
  });

  it("fails when the spec changed while backing up", async () => {
    const { s, agent } = await setup();
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    expect((await patch(s.id, { spec: { memory: "3G" } })).statusCode).toBe(200);
    expect(server(s.id).specVersion).toBe(2);
    agent!.send(progress(req, JobStatus.OK));
    await vi.waitFor(() => expect(job(jobId).status).toBe("failed"));
    expect(job(jobId).message).toBe("The configuration changed while the backup ran: the change was not applied. Review it and save again");
    expect(server(s.id).specVersion).toBe(2);
    expect(server(s.id).spec.mods).toBeDefined();
    agent!.close();
  });

  it("applies once even if the ok event repeats", async () => {
    const { s, agent } = await setup();
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    app.jobs.finish(backupJobId(req), "ok", "done");
    app.events.emit("job", app.jobs.get(backupJobId(req)), "");
    app.events.emit("job", app.jobs.get(backupJobId(req)), "");
    await vi.waitFor(() => expect(job(jobId).status).toBe("ok"));
    expect(server(s.id).specVersion).toBe(2);
    app.events.emit("job", app.jobs.get(backupJobId(req)), "");
    await vi.waitFor(() => expect(job(jobId).status).toBe("ok"));
    expect(server(s.id).specVersion).toBe(2);
    agent!.close();
  });

  it("handles a backup that already finished when the request returns", async () => {
    const { s, agent } = await setup();
    const pending = patch(s.id, { spec: { mods: null }, backupFirst: true });
    const req = await agent!.waitFor("backupNow");
    agent!.send(progress(req, JobStatus.OK));
    await vi.waitFor(() => expect(job(backupJobId(req)).status).toBe("ok"));
    agent!.ack(req.id);
    const res = await pending;
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as BackupFirstAccepted;
    await vi.waitFor(() => expect(job(jobId).status).toBe("ok"));
    expect(server(s.id).specVersion).toBe(2);
    agent!.close();
  });

  it("rejects a second backup-first change while one is waiting", async () => {
    const { s, agent } = await setup();
    await backupFirst(agent!, s.id, { spec: { mods: null } });
    const res = await patch(s.id, { spec: { memory: "3G" }, backupFirst: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "A change is already waiting for a backup of this server" });
    expect(app.jobs.list({ serverId: s.id }).filter((j) => j.type === "backup")).toHaveLength(1);
    agent!.close();
  });

  it("validates before backing up", async () => {
    const { s, agent } = await setup();
    for (const body of [{ spec: { memory: "lots" } }, { spec: { type: null } }, { spec: { env: { "1BAD": "x" } } }]) {
      const res = await patch(s.id, { ...body, backupFirst: true });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(app.jobs.list({ serverId: s.id })).toEqual([]);
    agent!.close();
  });

  it("needs the node online", async () => {
    const { s } = await setup(false);
    const res = await patch(s.id, { spec: { mods: null }, backupFirst: true });
    expect(res.statusCode).toBe(409);
    expect(app.jobs.list({ serverId: s.id })).toEqual([]);
    expect(server(s.id).specVersion).toBe(1);
  });

  it("without a spec change it behaves as a normal PATCH", async () => {
    const { s } = await setup(false);
    const res = await patch(s.id, { name: "x", backupFirst: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.id, name: "x", specVersion: 1 });
    expect((await patch(s.id, { spec: { memory: "2G" }, backupFirst: true })).statusCode).toBe(200);
    expect(app.jobs.list({ serverId: s.id })).toEqual([]);
  });

  it("a panel restart leaves the change unapplied", async () => {
    const { s, agent } = await setup();
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    app.jobs.interruptStale();
    expect(job(jobId)).toMatchObject({ status: "failed", message: expect.stringMatching(/interrupted/) });
    agent!.send(progress(req, JobStatus.OK));
    await vi.waitFor(() => expect(job(backupJobId(req)).status).toBe("ok"));
    expect(server(s.id).specVersion).toBe(1);
    expect(job(jobId).status).toBe("failed");
    // Nothing stays waiting: a new backup-first change is accepted.
    await backupFirst(agent!, s.id, { spec: { mods: null } });
    agent!.close();
  });

  it("a migration that starts meanwhile cancels the apply", async () => {
    const { s, nodeId, agent } = await setup();
    const b = await enrollNode("b");
    const { jobId, req } = await backupFirst(agent!, s.id, { spec: { mods: null } });
    app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: nodeId, target_node_id: b.nodeId, source_slug: "one", target_slug: "one",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(baseSpec), was_running: 1, delete_source: 0,
    });
    agent!.send(progress(req, JobStatus.OK));
    await vi.waitFor(() => expect(job(jobId).status).toBe("failed"));
    expect(job(jobId).message).toBe("A migration started: the change was not applied");
    expect(server(s.id).specVersion).toBe(1);
    agent!.close();
  });
});
