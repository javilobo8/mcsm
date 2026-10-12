import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { create } from "@bufbuild/protobuf";
import { LogLineSchema, ObservedSchema, ServerObservedSchema } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string; let nodeId: string; let nodeToken: string;

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

function browser(withCookie = true): Promise<{ ws: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers: withCookie ? { cookie } : {} });
    const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m); });
    ws.on("open", () => resolve({ ws, next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r, rj) => { const t = setTimeout(() => rj(new Error("sin mensaje")), 3000); waiters.push((m) => { clearTimeout(t); r(m); }); }) }));
    ws.on("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

describe("realtime", () => {
  it("exige sesión", async () => {
    await expect(browser(false)).rejects.toThrow(/401/);
  });

  it("reenvía estado observado y cambios de nodo", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const b = await browser();
    b.ws.send(JSON.stringify({ type: "subscribe", topic: "servers" }));
    b.ws.send(JSON.stringify({ type: "subscribe", topic: "nodes" }));
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    const nodeMsg = await b.next();
    expect(nodeMsg).toMatchObject({ type: "node", node: { id: nodeId, status: "online" } });
    agent.send({ body: { case: "serverObserved", value: create(ServerObservedSchema, { serverId: s.id, observed: create(ObservedSchema, { state: "running", appliedVersion: 1n }) }) } });
    let obs: any;
    do { obs = await b.next(); } while (obs.type !== "observed"); // puede llegar un segundo evento "node" tras el Hello
    expect(obs).toMatchObject({ type: "observed", serverId: s.id, observed: { state: "running", appliedVersion: 1 } });
    b.ws.close();
  });

  it("abre un stream de logs por servidor mientras haya suscriptores y avisa al cerrarse", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const b1 = await browser();
    const b2 = await browser();
    b1.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    const sub = await agent.waitFor("subscribeLogs");
    if (sub.body.case !== "subscribeLogs") throw new Error();
    expect(sub.body.value.serverId).toBe(s.id);
    expect(sub.body.value.tail).toBe(200);
    agent.ack(sub.id, sub.id); // Ack con stream_id = id
    b2.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    await new Promise((r) => setTimeout(r, 50));
    agent.send({ streamId: sub.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: s.id, tsUnixMs: 1760000000000n, line: "Done!" }) } });
    expect(await b1.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000000, line: "Done!" });
    expect(await b2.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000000, line: "Done!" });

    b1.ws.send(JSON.stringify({ type: "unsubscribe", topic: `server:${s.id}:logs` }));
    await new Promise((r) => setTimeout(r, 50));
    await expect(agent.next(300)).rejects.toThrow(); // con b2 aún suscrito, no se cierra el stream

    agent.close(); // el nodo cae
    const closed = await b2.next();
    expect(closed).toMatchObject({ type: "stream_closed", serverId: s.id });
    b2.ws.close();
  });

  it("cierra el stream del agente cuando se va el último suscriptor", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);
    const b = await browser();
    b.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    const sub = await agent.waitFor("subscribeLogs");
    agent.ack(sub.id, sub.id);
    b.ws.close();
    const close = await agent.waitFor("streamClose");
    expect(close.streamId).toBe(sub.id);
  });

  it("registra @fastify/websocket una sola vez (un upgrade se procesa una vez)", () => {
    expect(app.server.listenerCount("upgrade")).toBe(1);
  });

  it("reabre el stream de logs al volver el nodo, sin duplicados", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);
    const b = await browser();
    b.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
    const sub = await agent.waitFor("subscribeLogs");
    agent.ack(sub.id, sub.id);
    await new Promise((r) => setTimeout(r, 50));
    agent.close();
    expect(await b.next()).toMatchObject({ type: "stream_closed", serverId: s.id });

    const agent2 = new FakeAgent(url, nodeToken);
    await agent2.connect({ specVersions: { [s.id]: 1n } });
    const sub2 = await agent2.waitFor("subscribeLogs");
    agent2.ack(sub2.id, sub2.id);
    await new Promise((r) => setTimeout(r, 50));
    agent2.send({ streamId: sub2.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: s.id, tsUnixMs: 1760000000001n, line: "de nuevo" }) } });
    expect(await b.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000001, line: "de nuevo" });
    await expect(b.next()).rejects.toThrow(); // sin duplicados
    // un solo subscribeLogs
    await expect(agent2.waitFor("subscribeLogs", 300)).rejects.toThrow();
    b.ws.close();
    agent2.close();
  });
});
