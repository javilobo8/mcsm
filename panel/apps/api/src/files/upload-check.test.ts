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

describe("comprobación previa de una subida", () => {
  it("404 sin servidor, 409 con el nodo desconectado o una copia/restauración en curso; 204 si nada lo impide", async () => {
    expect((await check("no-existe")).statusCode).toBe(404);
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    let res = await check(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desconectado/);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    expect((await check(s.id)).statusCode).toBe(204);
    const backup = app.jobs.create({ type: "backup", serverId: s.id, nodeId, status: "running" });
    res = await check(s.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/copia de seguridad en curso/);
    app.jobs.finish(backup.id, "ok", "hecha");
    app.jobs.create({ type: "restore", serverId: s.id, nodeId, status: "running" });
    expect((await check(s.id)).json().error).toMatch(/restauración en curso/);
    agent.close();
  });
});
