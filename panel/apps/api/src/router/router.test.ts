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
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const getRouter = async (id = nodeId) => await app.inject({ method: "GET", url: `/api/nodes/${id}/router`, headers: { cookie } });
const putRouter = async (payload: object, id = nodeId) => await app.inject({ method: "PUT", url: `/api/nodes/${id}/router`, headers: { cookie }, payload });
/** Connects a fake agent and waits for the panel to process the SyncSpecs Ack (`ready`). */
const connect = async () => {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  await app.agents.get(nodeId)!.ready;
  return agent;
};

describe("a node's router: configuration", () => {
  it("not configured: disabled on 25565, no state; 404 if the node does not exist", async () => {
    const res = await getRouter();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      nodeId, spec: { enabled: false, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] }, observed: null, observedAt: null, updatedAt: null,
    });
    expect((await getRouter("no-existe")).statusCode).toBe(404);
    expect((await putRouter({ enabled: true }, "no-existe")).statusCode).toBe(404);
  });

  it("validates the configuration (400) and stores it with the node offline", async () => {
    expect((await putRouter({ enabled: true, port: 0 })).statusCode).toBe(400);
    expect((await putRouter({ enabled: true, autoscaleDownAfterMinutes: 2000 })).statusCode).toBe(400);
    const res = await putRouter({ enabled: true, port: 25590, autoscale: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).toEqual({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] });
    expect((await putRouter({ enabled: true, autoscale: true, autoscaleAllowPlayers: ["a b"] })).statusCode).toBe(400);
    expect(res.json().updatedAt).not.toBeNull();
    expect((await getRouter()).json().spec.port).toBe(25590);
  });

  it("409 if the router's port is published by a server on the node (game or extra)", async () => {
    await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "One", spec: { ports: { game: 25565, extra: [{ host: 25580, container: 8100, proto: "tcp", label: "mapa" }] } } } });
    for (const port of [25565, 25580]) {
      const res = await putRouter({ enabled: true, port });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/is used by server “One”/);
    }
    // Disabled does not reserve the port: it can be saved.
    expect((await putRouter({ enabled: false, port: 25565 })).statusCode).toBe(200);
  });
});

describe("a node's router: agent", () => {
  it("enabling sends RouterApply and disabling RouterRemove; responds after the Ack", async () => {
    const agent = await connect();
    const put = putRouter({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    const apply = await agent.waitFor("routerApply");
    if (apply.body.case !== "routerApply") throw new Error();
    expect(apply.body.value.spec).toMatchObject({ hostPort: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.ack(apply.id);
    expect((await put).statusCode).toBe(200);

    const off = putRouter({ enabled: false, port: 25590 });
    const remove = await agent.waitFor("routerRemove");
    agent.ack(remove.id);
    expect((await off).json().spec.enabled).toBe(false);
    agent.close();
  });

  it("an out-of-date agent (unsupported): enabling is 409 and is not saved; disabling is", async () => {
    const agent = await connect();
    const unsupported = (a: FakeAgent, id: bigint) => a.send({ id, body: { case: "error", value: { code: "unsupported", message: "unknown message: update the agent" } } });
    const put = putRouter({ enabled: true, port: 25590 });
    unsupported(agent, (await agent.waitFor("routerApply")).id);
    const res = await put;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("The agent on this node is out of date and does not support the router (mc-router): update it. The change was not saved.");
    // With no previous row it goes back to “not configured”: the port is not reserved nor the node blocked.
    expect((await getRouter()).json()).toMatchObject({ spec: { enabled: false, port: 25565 }, updatedAt: null });
    // With a previous configuration (saved with the node offline), it goes back to it.
    const gone = new Promise<void>((r) => app.agents.once("detached", () => r()));
    agent.close();
    await gone;
    expect((await putRouter({ enabled: false, port: 25600 })).statusCode).toBe(200);
    const again = await connect();
    unsupported(again, (await again.waitFor("routerRemove")).id); // resend after the handshake
    const put2 = putRouter({ enabled: true, port: 25591 });
    unsupported(again, (await again.waitFor("routerApply")).id);
    expect((await put2).statusCode).toBe(409);
    expect((await getRouter()).json().spec).toMatchObject({ enabled: false, port: 25600 });
    // Disabling on an agent without a router has nothing to remove: it is saved.
    const off = putRouter({ enabled: false, port: 25601 });
    unsupported(again, (await again.waitFor("routerRemove")).id);
    expect((await off).statusCode).toBe(200);
    expect((await getRouter()).json().spec.port).toBe(25601);
    again.close();
  });

  it("after the handshake the stored configuration is resent; with no row nothing is sent", async () => {
    let agent = await connect();
    // No row: between the handshake and the next send (a new server) nothing from the router arrives.
    const created = app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "One" } });
    const seen: string[] = [];
    for (let e = await agent.next(); ; e = await agent.next()) {
      seen.push(e.body.case ?? "");
      if (e.body.case === "applySpec") { agent.ack(e.id); break; }
    }
    expect(seen.filter((c) => c.startsWith("router"))).toEqual([]);
    await created;
    const gone = new Promise<void>((r) => app.agents.once("detached", () => r()));
    agent.close();
    await gone;

    await putRouter({ enabled: true, port: 25590 }); // offline: only saved
    agent = await connect();
    const apply = await agent.waitFor("routerApply");
    if (apply.body.case !== "routerApply") throw new Error();
    expect(apply.body.value.spec?.hostPort).toBe(25590);
    agent.ack(apply.id);
    agent.close();
  });

  it("two consecutive changes arrive in order and the last one is the current one", async () => {
    const agent = await connect();
    const a = putRouter({ enabled: true, port: 25590 });
    const b = putRouter({ enabled: true, port: 25591 });
    const first = await agent.waitFor("routerApply");
    agent.ack(first.id);
    const second = await agent.waitFor("routerApply");
    agent.ack(second.id);
    await Promise.all([a, b]);
    if (second.body.case !== "routerApply") throw new Error();
    expect(second.body.value.spec?.hostPort).toBe(25591);
    agent.close();
  });

  it("RouterObserved is stored, published and removes a router the panel does not want", async () => {
    const events: unknown[] = [];
    app.events.on("router", (_id: string, dto: unknown) => events.push(dto));
    const agent = await connect();
    // No row and no router on the agent: nothing is created.
    agent.send({ body: { case: "routerObserved", value: { configured: false, state: "missing" } } });
    // No row and a router on the agent (panel DB restored): it is stored and asked to be removed.
    agent.send({ body: { case: "routerObserved", value: { configured: true, state: "running", containerId: "c1", image: "itzg/mc-router:1.47.1", hostPort: 25565 } } });
    const remove = await agent.waitFor("routerRemove");
    agent.ack(remove.id);
    const dto = (await getRouter()).json();
    expect(dto.spec.enabled).toBe(false);
    expect(dto.observed).toEqual({
      configured: true, state: "running", containerId: "c1", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: false, error: "",
      autoscaleDownAfterMinutes: 0, autoscaleAllowPlayers: [],
    });
    expect(dto.observedAt).not.toBeNull();
    expect(events).toHaveLength(1);
    agent.close();
  });

  it("the spec applied on the agent travels in the observed state (minutes and autoscale list)", async () => {
    const agent = await connect();
    const put = putRouter({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.ack((await agent.waitFor("routerApply")).id);
    await put;
    const changed = new Promise<void>((r) => app.events.once("router", () => r()));
    agent.send({ body: { case: "routerObserved", value: {
      configured: true, state: "running", hostPort: 25590, autoscale: true,
      spec: { hostPort: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] },
    } } });
    await changed;
    expect((await getRouter()).json().observed).toMatchObject({ autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.close();
  });
});
