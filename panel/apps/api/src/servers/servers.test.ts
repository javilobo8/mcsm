import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const post = async (u: string, payload: object) => await app.inject({ method: "POST", url: u, headers: { cookie }, payload });

describe("servers", () => {
  it("creates with generated slug, port and rconPassword; hides the secret in listings", async () => {
    let res = await post("/api/servers", { nodeId, name: "Survival 2024 ñ", spec: { type: "PAPER", version: "1.21.4", memory: "4G" } });
    expect(res.statusCode).toBe(201);
    const s1 = res.json();
    expect(s1.slug).toBe("survival-2024-n");
    expect(s1.spec.ports.game).toBe(25565);
    expect(s1.spec.rconPassword).toHaveLength(43);
    expect(s1.desiredState).toBe("stopped");
    res = await post("/api/servers", { nodeId, name: "Creative" });
    expect(res.json().spec.ports.game).toBe(25566);
    res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie } });
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].spec.rconPassword).toBeUndefined();
    res = await app.inject({ method: "GET", url: `/api/servers/${s1.id}`, headers: { cookie } });
    expect(res.json().spec.rconPassword).toHaveLength(43);
  });

  it("rejects a duplicate slug and a taken port on the same node", async () => {
    await post("/api/servers", { nodeId, name: "One", slug: "one", spec: { ports: { game: 25570 } } });
    let res = await post("/api/servers", { nodeId, name: "Other", slug: "one" });
    expect(res.statusCode).toBe(409);
    res = await post("/api/servers", { nodeId, name: "Two", spec: { ports: { game: 25570 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/port/i);
  });

  it("validates the spec (reserved env, memLimit)", async () => {
    let res = await post("/api/servers", { nodeId, name: "X", spec: { env: { TYPE: "FORGE" } } });
    expect(res.statusCode).toBe(400);
    res = await post("/api/servers", { nodeId, name: "X", spec: { memory: "4G", resources: { cpus: 0, memLimit: "2G" } } });
    expect(res.statusCode).toBe(400);
  });

  it("with the node offline: create works, power and command return 409", async () => {
    const s = (await post("/api/servers", { nodeId, name: "One" })).json();
    let res = await post(`/api/servers/${s.id}/power`, { action: "start" });
    expect(res.statusCode).toBe(409);
    res = await post(`/api/servers/${s.id}/command`, { command: "list" });
    expect(res.statusCode).toBe(409);
  });

  it("with the node online: create, edit, power and command reach the agent", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const created = post("/api/servers", { nodeId, name: "One", desiredState: "running" });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(apply.body.value.server!.slug).toBe("one");
    expect(apply.body.value.server!.version).toBe(1n);
    expect(apply.body.value.server!.desiredState).toBe(1); // RUNNING
    agent.ack(apply.id);
    const s = (await created).json();

    const patched = app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { name: "One renamed", spec: { memory: "3G" } } });
    const apply2 = await agent.waitFor("applySpec");
    if (apply2.body.case !== "applySpec") throw new Error();
    expect(apply2.body.value.server!.version).toBe(2n);
    expect(JSON.parse(new TextDecoder().decode(apply2.body.value.server!.specJson)).memory).toBe("3G");
    agent.ack(apply2.id);
    expect((await patched).json()).toMatchObject({ name: "One renamed", specVersion: 2 });

    const power = post(`/api/servers/${s.id}/power`, { action: "stop" });
    const pa = await agent.waitFor("powerAction");
    if (pa.body.case !== "powerAction") throw new Error();
    expect(pa.body.value.action).toBe(2); // STOP
    agent.ack(pa.id);
    expect((await power).statusCode).toBe(200);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");

    const cmd = post(`/api/servers/${s.id}/command`, { command: "list" });
    const sc = await agent.waitFor("sendCommand");
    agent.send({ id: sc.id, body: { case: "commandResult", value: { output: "There are 0 of a max of 10 players online" } } });
    expect((await cmd).json()).toEqual({ output: "There are 0 of a max of 10 players online" });

    const del = app.inject({ method: "DELETE", url: `/api/servers/${s.id}?deleteData=true`, headers: { cookie } });
    const rm = await agent.waitFor("removeServer");
    if (rm.body.case !== "removeServer") throw new Error();
    expect(rm.body.value.deleteData).toBe(true);
    agent.ack(rm.id);
    expect((await del).statusCode).toBe(204);
    expect(app.servers.get(s.id)).toBeNull();
  });

  it("a PATCH that only changes the name does not increment spec_version", async () => {
    const s = (await post("/api/servers", { nodeId, name: "One" })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { name: "Renombrado" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Renombrado", specVersion: 1 });
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });

  it("the allocator avoids the ports of other servers on the node within 25565-25600", async () => {
    await post("/api/servers", { nodeId, name: "A", spec: { ports: { game: 25566 } } });
    await post("/api/servers", { nodeId, name: "B", spec: { ports: { game: 25568, extra: [{ host: 25565, container: 19132, proto: "udp" }] } } });
    const c = (await post("/api/servers", { nodeId, name: "C" })).json();
    expect(c.spec.ports.game).toBe(25567);
    const d = (await post("/api/servers", { nodeId, name: "D" })).json();
    expect(d.spec.ports.game).toBe(25569);
    for (const p of [c, d]) expect(p.spec.ports.game).toBeGreaterThanOrEqual(25565);
    expect(app.serversService.allocatePort(nodeId)).toBe(25570);
  });

  it("a PATCH during synchronization does not reach the agent until the SyncSpecs Ack", async () => {
    const s = (await post("/api/servers", { nodeId, name: "One" })).json(); // node still disconnected
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    const sync = await agent.waitFor("syncSpecs");
    const res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { spec: { memory: "3G" } } });
    expect(res.statusCode).toBe(200);
    await expect(agent.next(150)).rejects.toThrow(/no message/);
    agent.ack(sync.id);
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(apply.body.value.server!.version).toBe(2n);
    agent.ack(apply.id);
    agent.close();
  });

  it("power: if the agent responds Error it returns 502 and does not change desired_state", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);
    const s = (await post("/api/servers", { nodeId, name: "One" })).json();
    agent.ack((await agent.waitFor("applySpec")).id);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");
    const power = post(`/api/servers/${s.id}/power`, { action: "start" });
    const pa = await agent.waitFor("powerAction");
    agent.send({ id: pa.id, body: { case: "error", value: { code: "docker_failed", message: "does not start" } } });
    expect((await power).statusCode).toBe(502);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");
    agent.close();
  });

  it("a repeated autogenerated slug gets a suffix; a repeated explicit one gives 409", async () => {
    const a = (await post("/api/servers", { nodeId, name: "Prueba" })).json();
    const b = (await post("/api/servers", { nodeId, name: "Prueba" })).json();
    const c = (await post("/api/servers", { nodeId, name: "Prueba" })).json();
    expect([a.slug, b.slug, c.slug]).toEqual(["prueba", "prueba-2", "prueba-3"]);
    expect((await post("/api/servers", { nodeId, name: "X", slug: "prueba" })).statusCode).toBe(409);
    const long = "n".repeat(60);
    const l1 = (await post("/api/servers", { nodeId, name: long })).json();
    const l2 = (await post("/api/servers", { nodeId, name: long })).json();
    expect(l1.slug).toHaveLength(40);
    expect(l2.slug).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(l2.slug).not.toBe(l1.slug);
    expect(l2.slug.endsWith("-2")).toBe(true);
  });

  it("the auto-assigned game port avoids the hosts of the spec's own ports.extra", async () => {
    const res = await post("/api/servers", { nodeId, name: "E", spec: { ports: { extra: [{ host: 25565, container: 19132, proto: "udp" }] } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.ports.game).toBe(25566);
  });

  it("an internal error returns a generic 500 without leaking the message; malformed JSON gives 400", async () => {
    const orig = app.servers.list.bind(app.servers);
    app.servers.list = () => { throw new Error("SQLITE_ERROR /secret/path"); };
    let res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie } });
    app.servers.list = orig;
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/SQLITE|secret/);
    expect(res.json()).toEqual({ error: "Internal error" });
    res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, "content-type": "application/json" }, payload: "{mal" });
    expect(res.statusCode).toBe(400);
  });
});
