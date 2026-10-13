import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { BackupTrigger } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

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

async function setupBackup(trigger = BackupTrigger.MANUAL, filename = "uno-20261013-040000-1.tar.zst") {
  const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  agent.ack((await agent.waitFor("backupList")).id);
  const seen = new Promise((resolve) => app.events.once("backups", resolve));
  agent.send({ body: { case: "backupCreated", value: { jobId: "", backup: {
    serverId: s.id, filename, sizeBytes: 5n, sha256: "ab".repeat(32), specVersion: 1n, trigger,
    startedUnixMs: BigInt(Date.now()), finishedUnixMs: BigInt(Date.now()),
  } } } });
  await seen;
  const [b] = (await app.inject({ method: "GET", url: `/api/servers/${s.id}/backups`, headers: { cookie } })).json();
  return { s, agent, b };
}

describe("backup download", () => {
  it("the agent uploads the backup to the panel and the browser receives it streaming", async () => {
    const { s, agent, b } = await setupBackup();
    const browser = fetch(`${url}/api/servers/${s.id}/backups/${b.id}/download`, { headers: { cookie } });
    const push = await agent.waitFor("backupPush");
    if (push.body.case !== "backupPush") throw new Error();
    expect(push.body.value).toMatchObject({ serverId: s.id, filename: b.filename });
    const put = fetch(`${url}/agent/transfer/${push.body.value.transferId}`, {
      method: "PUT", headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    const res = await browser;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(b.filename);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect((await put).status).toBe(204);
    agent.send({ id: push.id, body: { case: "backupPushResult", value: { sizeBytes: 5n, sha256: "ab".repeat(32) } } });
    agent.close();
  });

  it("400 with pre-restore data, 404 without a backup and 409 with the node offline", async () => {
    const { s, agent, b } = await setupBackup(BackupTrigger.PRE_RESTORE, "data.pre-restore-20261013-040000");
    expect((await app.inject({ method: "GET", url: `/api/servers/${s.id}/backups/${b.id}/download`, headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/servers/${s.id}/backups/no-existe/download`, headers: { cookie } })).statusCode).toBe(404);
    agent.close();
  });

  it("cutting the browser mid-download cancels the transfer and cuts the agent's PUT", async () => {
    const { s, agent, b } = await setupBackup();
    const ctrl = new AbortController();
    const browser = fetch(`${url}/api/servers/${s.id}/backups/${b.id}/download`, { headers: { cookie }, signal: ctrl.signal });
    const push = await agent.waitFor("backupPush");
    if (push.body.case !== "backupPush") throw new Error();
    // PUT that never ends: sends a chunk and stays open.
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => { body = c; } });
    const put = fetch(`${url}/agent/transfer/${push.body.value.transferId}`, {
      method: "PUT", headers: { authorization: `Bearer ${nodeToken}`, "content-type": "application/octet-stream" }, body: stream, duplex: "half",
    } as RequestInit);
    body.enqueue(new Uint8Array([1, 2]));
    const res = await browser;
    await res.body!.getReader().read(); // it already flows towards the browser
    ctrl.abort(); // the browser leaves
    await expect(put).rejects.toThrow(); // the panel cuts the agent's connection
    agent.close();
  });

  it("404 when requesting another server's backup", async () => {
    const { agent, b } = await setupBackup();
    const other = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Dos" } })).json();
    const res = await app.inject({ method: "GET", url: `/api/servers/${other.id}/backups/${b.id}/download`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    agent.close();
  });

  it("409 with the node offline", async () => {
    const { s, agent, b } = await setupBackup();
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    const res = await app.inject({ method: "GET", url: `/api/servers/${s.id}/backups/${b.id}/download`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });
});
