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

describe("servidores", () => {
  it("crea con slug, puerto y rconPassword generados; oculta el secreto en listados", async () => {
    let res = await post("/api/servers", { nodeId, name: "Supervivencia 2024 ñ", spec: { type: "PAPER", version: "1.21.4", memory: "4G" } });
    expect(res.statusCode).toBe(201);
    const s1 = res.json();
    expect(s1.slug).toBe("supervivencia-2024-n");
    expect(s1.spec.ports.game).toBe(25565);
    expect(s1.spec.rconPassword).toHaveLength(43);
    expect(s1.desiredState).toBe("stopped");
    res = await post("/api/servers", { nodeId, name: "Creativo" });
    expect(res.json().spec.ports.game).toBe(25566);
    res = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie } });
    expect(res.json()).toHaveLength(2);
    expect(res.json()[0].spec.rconPassword).toBeUndefined();
    res = await app.inject({ method: "GET", url: `/api/servers/${s1.id}`, headers: { cookie } });
    expect(res.json().spec.rconPassword).toHaveLength(43);
  });

  it("rechaza slug duplicado y puerto ocupado en el mismo nodo", async () => {
    await post("/api/servers", { nodeId, name: "Uno", slug: "uno", spec: { ports: { game: 25570 } } });
    let res = await post("/api/servers", { nodeId, name: "Otro", slug: "uno" });
    expect(res.statusCode).toBe(409);
    res = await post("/api/servers", { nodeId, name: "Dos", spec: { ports: { game: 25570 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/puerto/i);
  });

  it("valida la spec (env reservada, memLimit)", async () => {
    let res = await post("/api/servers", { nodeId, name: "X", spec: { env: { TYPE: "FORGE" } } });
    expect(res.statusCode).toBe(400);
    res = await post("/api/servers", { nodeId, name: "X", spec: { memory: "4G", resources: { cpus: 0, memLimit: "2G" } } });
    expect(res.statusCode).toBe(400);
  });

  it("con el nodo offline: crear funciona, power y command devuelven 409", async () => {
    const s = (await post("/api/servers", { nodeId, name: "Uno" })).json();
    let res = await post(`/api/servers/${s.id}/power`, { action: "start" });
    expect(res.statusCode).toBe(409);
    res = await post(`/api/servers/${s.id}/command`, { command: "list" });
    expect(res.statusCode).toBe(409);
  });

  it("con el nodo online: crear, editar, power y command llegan al agente", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const created = post("/api/servers", { nodeId, name: "Uno", desiredState: "running" });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(apply.body.value.server!.slug).toBe("uno");
    expect(apply.body.value.server!.version).toBe(1n);
    expect(apply.body.value.server!.desiredState).toBe(1); // RUNNING
    agent.ack(apply.id);
    const s = (await created).json();

    const patched = app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { name: "Uno renombrado", spec: { memory: "3G" } } });
    const apply2 = await agent.waitFor("applySpec");
    if (apply2.body.case !== "applySpec") throw new Error();
    expect(apply2.body.value.server!.version).toBe(2n);
    expect(JSON.parse(new TextDecoder().decode(apply2.body.value.server!.specJson)).memory).toBe("3G");
    agent.ack(apply2.id);
    expect((await patched).json()).toMatchObject({ name: "Uno renombrado", specVersion: 2 });

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

  it("un PATCH que solo cambia el nombre no incrementa spec_version", async () => {
    const s = (await post("/api/servers", { nodeId, name: "Uno" })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie }, payload: { name: "Renombrado" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Renombrado", specVersion: 1 });
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });

  it("el asignador evita los puertos de otros servidores del nodo dentro de 25565-25600", async () => {
    await post("/api/servers", { nodeId, name: "A", spec: { ports: { game: 25566 } } });
    await post("/api/servers", { nodeId, name: "B", spec: { ports: { game: 25568, extra: [{ host: 25565, container: 19132, proto: "udp" }] } } });
    const c = (await post("/api/servers", { nodeId, name: "C" })).json();
    expect(c.spec.ports.game).toBe(25567);
    const d = (await post("/api/servers", { nodeId, name: "D" })).json();
    expect(d.spec.ports.game).toBe(25569);
    for (const p of [c, d]) expect(p.spec.ports.game).toBeGreaterThanOrEqual(25565);
    expect(app.serversService.allocatePort(nodeId)).toBe(25570);
  });

  it("power: si el agente responde Error devuelve 502 y no cambia desired_state", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);
    const s = (await post("/api/servers", { nodeId, name: "Uno" })).json();
    agent.ack((await agent.waitFor("applySpec")).id);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");
    const power = post(`/api/servers/${s.id}/power`, { action: "start" });
    const pa = await agent.waitFor("powerAction");
    agent.send({ id: pa.id, body: { case: "error", value: { code: "docker_failed", message: "no arranca" } } });
    expect((await power).statusCode).toBe(502);
    expect(app.servers.get(s.id)!.desired_state).toBe("stopped");
    agent.close();
  });
});
