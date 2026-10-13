import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

const enroll = async (name: string) => {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json() as { nodeId: string; nodeToken: string };
};

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  ({ nodeId, nodeToken } = await enroll("nas"));
});
afterEach(async () => { await app.close(); });

const post = async (u: string, payload: object) => await app.inject({ method: "POST", url: u, headers: { cookie }, payload });
const patch = async (u: string, payload: object) => await app.inject({ method: "PATCH", url: u, headers: { cookie }, payload });
const routed = (hostname: string, enabled = true) => ({ router: { enabled, hostname } });

describe("servers and nodes with a router", () => {
  it("stores the router section and validates it", async () => {
    let res = await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.router).toEqual({ enabled: true, hostname: "survival.lan" });
    res = await post("/api/servers", { nodeId, name: "Mal", spec: routed("Survival.LAN") });
    expect(res.statusCode).toBe(400);
    res = await post("/api/servers", { nodeId, name: "Bare", spec: routed("") });
    expect(res.statusCode).toBe(400);
  });

  it("the hostname is unique per node among servers with the router enabled", async () => {
    const a = (await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") })).json();
    let res = await post("/api/servers", { nodeId, name: "Other", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Hostname “survival.lan” is already used by server “Survival” on this node");
    // Disabled does not compete; enabling it afterwards does.
    const b = (await post("/api/servers", { nodeId, name: "Creative", spec: routed("survival.lan", false) })).json();
    expect(b.id).toBeDefined();
    res = await patch(`/api/servers/${b.id}`, { spec: routed("survival.lan") });
    expect(res.statusCode).toBe(409);
    res = await patch(`/api/servers/${b.id}`, { spec: routed("creative.lan") });
    expect(res.statusCode).toBe(200);
    // Editing itself does not clash with itself.
    res = await patch(`/api/servers/${a.id}`, { spec: { memory: "3G", ...routed("survival.lan") } });
    expect(res.statusCode).toBe(200);
    // Another node can use the same hostname (its DNS points to another machine).
    const other = await enroll("salon");
    res = await post("/api/servers", { nodeId: other.nodeId, name: "Survival", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(201);
  });

  it("with the router enabled its port is neither assigned nor can be published", async () => {
    expect((await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload: { enabled: true } })).statusCode).toBe(200);
    let res = await post("/api/servers", { nodeId, name: "One" });
    expect(res.json().spec.ports.game).toBe(25566);
    res = await post("/api/servers", { nodeId, name: "Two", spec: { ports: { game: 25565 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/router/);
    res = await post("/api/servers", { nodeId, name: "Tres", spec: { ports: { game: 25570, extra: [{ host: 25565, container: 8100, proto: "tcp", label: "x" }] } } });
    expect(res.statusCode).toBe(409);
    // Disabled, the port is free again.
    await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload: { enabled: false } });
    expect((await post("/api/servers", { nodeId, name: "Cuatro", spec: { ports: { game: 25565 } } })).statusCode).toBe(201);
  });

  it("the spec the agent receives carries the router", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    const created = post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(JSON.parse(new TextDecoder().decode(apply.body.value.server!.specJson)).router).toEqual({ enabled: true, hostname: "survival.lan" });
    agent.ack(apply.id);
    await created;
    agent.close();
  });

  it("deleting a node with the router enabled is 409; disabled it is deleted with its row", async () => {
    const put = async (payload: object) => await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload });
    await put({ enabled: true, port: 25590 });
    let res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Disable the node's router before deleting it");
    await put({ enabled: false, port: 25590 });
    res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM router_deployments").get()).toEqual({ n: 0 });
  });

  it("deleting a node with the router being removed: 409 online; offline it is allowed (the next agent removes it)", async () => {
    const put = async (payload: object) => await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload });
    const del = async () => await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    await app.agents.get(nodeId)!.ready;
    const on = put({ enabled: true, port: 25590 });
    agent.ack((await agent.waitFor("routerApply")).id);
    await on;
    const observed = (configured: boolean) => new Promise<void>((r) => {
      app.events.once("router", () => r());
      agent.send({ body: { case: "routerObserved", value: { configured, state: configured ? "running" : "missing", hostPort: configured ? 25590 : 0 } } });
    });
    await observed(true);
    const off = put({ enabled: false, port: 25590 });
    agent.ack((await agent.waitFor("routerRemove")).id);
    await off;
    // The agent has not yet reported that it removed it.
    let res = await del();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("This node's router is still being removed: wait a few seconds and try again");
    // Offline with the router still deployed: allowed (otherwise a node on a lost machine could
    // never be deleted); the orphaned router is removed by the agent that starts again there.
    const gone = new Promise<void>((r) => app.agents.once("detached", () => r()));
    agent.close();
    await gone;
    res = await del();
    expect(res.statusCode).toBe(204);
  });

  it("a template saved from a server does not carry the router", async () => {
    const s = (await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") })).json();
    const res = await post("/api/templates", { name: "Base", fromServerId: s.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.router).toBeUndefined();
  });
});
