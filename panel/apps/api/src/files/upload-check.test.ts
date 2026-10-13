import { specSchema } from "@mcsm/shared";
import { newId } from "../lib/ids.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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

const check = (id: string) => app.inject({ method: "GET", url: `/api/servers/${id}/files/upload-check`, headers: { cookie } });

describe("upload pre-check", () => {
  it("404 without a server, 409 with the node offline or a backup/restore in progress; 204 if nothing prevents it", async () => {
    expect((await check("no-existe")).statusCode).toBe(404);
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "One" } })).json();
    let res = await check(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/offline/);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    expect((await check(s.id)).statusCode).toBe(204);
    const backup = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" });
    res = await check(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/backup is in progress/);
    app.jobs.finish(backup.id, "ok", "hecha");
    app.jobs.create({ type: "restore", serverId: s.id, nodeId, status: "running" });
    expect((await check(s.id)).json().error).toMatch(/restore is in progress/);
    agent.close();
  });

  it("409 with the server being migrated", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "other" } })).json().token;
    const other = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "other", agentVersion: "fake" } })).json();
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "One" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    expect((await check(s.id)).statusCode).toBe(204);
    const spec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });
    app.migrations.insert({
      id: newId(), server_id: s.id, source_node_id: nodeId, target_node_id: other.nodeId, source_slug: "one", target_slug: "one",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(spec), was_running: 0, delete_source: 0,
    });
    const res = await check(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is being migrated/);
    agent.close();
  });
});
