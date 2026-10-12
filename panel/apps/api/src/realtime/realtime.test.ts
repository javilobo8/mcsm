import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { create } from "@bufbuild/protobuf";
import { LogLineSchema, ObservedSchema, ServerObservedSchema } from "@mcsm/proto";
import { EventEmitter } from "node:events";
import { BrowserHub } from "./hub.js";
import { originAllowed } from "./routes.js";
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

function browser(withCookie = true, origin?: string): Promise<{ ws: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = withCookie ? { cookie } : {};
    if (origin !== undefined) headers.origin = origin;
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers });
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

  // L2: SameSite=Strict no frena a una página same-site (mismo host, otro puerto): el
  // navegador adjunta la cookie al WS y los WS no pasan por CORS. Se exige Origin == Host.
  it("originAllowed: Origin igual al Host o al origen de PANEL_PUBLIC_URL", () => {
    expect(originAllowed(undefined, "panel:8080", "")).toBe(true);
    expect(originAllowed("http://panel:8080", "panel:8080", "")).toBe(true);
    expect(originAllowed("http://PANEL:8080", "panel:8080", "")).toBe(true);
    expect(originAllowed("http://panel:9090", "panel:8080", "")).toBe(false);
    expect(originAllowed("https://panel:8080", "panel:8080", "")).toBe(true); // tras un proxy TLS
    expect(originAllowed("http://lan.casa:8080", "127.0.0.1:8080", "http://lan.casa:8080")).toBe(true);
    expect(originAllowed("http://otro:8080", "127.0.0.1:8080", "http://lan.casa:8080")).toBe(false);
    expect(originAllowed("no es url", "panel:8080", "")).toBe(false);
  });

  it("rechaza el upgrade con un Origin de otro host o puerto", async () => {
    const port = new URL(url).port;
    await expect(browser(true, `http://127.0.0.1:${Number(port) + 1}`)).rejects.toThrow(/403/);
    await expect(browser(true, "http://evil.example")).rejects.toThrow(/403/);
    await expect(browser(true, "null")).rejects.toThrow(/403/);
    const ok = await browser(true, url);
    ok.ws.close();
    const sinOrigin = await browser(true); // clientes que no son navegador no envían Origin
    sinOrigin.ws.close();
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
    expect(await b1.next()).toEqual({ type: "log_reset", serverId: s.id });
    expect(await b2.next()).toEqual({ type: "log_reset", serverId: s.id });
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
    expect(await b.next()).toEqual({ type: "log_reset", serverId: s.id });
    agent.close();
    expect(await b.next()).toMatchObject({ type: "stream_closed", serverId: s.id });

    const agent2 = new FakeAgent(url, nodeToken);
    await agent2.connect({ specVersions: { [s.id]: 1n } });
    await agent2.handshake(); // el stream se reabre tras el Ack de SyncSpecs (AgentConn.ready)
    const sub2 = await agent2.waitFor("subscribeLogs");
    agent2.ack(sub2.id, sub2.id);
    expect(await b.next()).toEqual({ type: "log_reset", serverId: s.id });
    agent2.send({ streamId: sub2.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: s.id, tsUnixMs: 1760000000001n, line: "de nuevo" }) } });
    expect(await b.next()).toEqual({ type: "log", serverId: s.id, ts: 1760000000001, line: "de nuevo" });
    await expect(b.next()).rejects.toThrow(); // sin duplicados
    // un solo subscribeLogs
    await expect(agent2.waitFor("subscribeLogs", 300)).rejects.toThrow();
    b.ws.close();
    agent2.close();
  });

  describe("ronda de arreglos 1", () => {
    async function setup() {
      const s = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json();
      const agent = new FakeAgent(url, nodeToken);
      await agent.connect({ specVersions: { [s.id]: 1n } });
      await agent.waitFor("helloAck");
      agent.ack((await agent.waitFor("syncSpecs")).id);
      return { s, agent };
    }
    const logLine = (serverId: string, ts: number, line: string) =>
      ({ case: "logLine" as const, value: create(LogLineSchema, { serverId, tsUnixMs: BigInt(ts), line }) });

    it("ignora mensajes malformados sin tumbar el panel y responde error", async () => {
      const b = await browser();
      for (const raw of ["null", "[]", '"x"', "{", JSON.stringify({ type: "subscribe", topic: "raro" }), JSON.stringify({ type: "subscribe", topic: "server:a:b:logs" })]) {
        b.ws.send(raw);
        expect(await b.next()).toMatchObject({ type: "error" });
      }
      b.ws.send(Buffer.from([0xff, 0x00, 0x01]));
      expect(await b.next()).toMatchObject({ type: "error" });
      b.ws.send(JSON.stringify({ type: "subscribe", topic: "nodes" }));
      const agent = new FakeAgent(url, nodeToken);
      await agent.connect();
      expect(await b.next()).toMatchObject({ type: "node" });
      b.ws.close(); agent.close();
    });

    it("limita las suscripciones por socket", async () => {
      const hub = new BrowserHub(app, { maxSubscriptions: 2 });
      const sock = new FakeSocket();
      hub.add(sock as never);
      for (const t of ["servers", "nodes", "servers"]) sock.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topic: t })));
      expect(sock.sent).toEqual([]); // la repetida no cuenta
      const { s } = await setup();
      sock.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` })));
      expect(sock.sent.find((m) => m.type === "error")).toMatchObject({ type: "error", message: expect.stringMatching(/suscripciones/) });
      hub.dispose();
    });

    it("envía log_reset antes de la cola tras reabrir por reconexión del nodo", async () => {
      const { s, agent } = await setup();
      const b = await browser();
      b.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
      const sub = await agent.waitFor("subscribeLogs");
      agent.ack(sub.id, sub.id);
      expect(await b.next()).toEqual({ type: "log_reset", serverId: s.id });
      agent.send({ streamId: sub.id, body: logLine(s.id, 1, "vieja") });
      expect(await b.next()).toMatchObject({ type: "log", line: "vieja" });
      agent.close();
      expect(await b.next()).toMatchObject({ type: "stream_closed" });
      const agent2 = new FakeAgent(url, nodeToken);
      await agent2.connect({ specVersions: { [s.id]: 1n } });
      await agent2.handshake();
      const sub2 = await agent2.waitFor("subscribeLogs");
      agent2.ack(sub2.id, sub2.id);
      expect(await b.next()).toEqual({ type: "log_reset", serverId: s.id });
      agent2.send({ streamId: sub2.id, body: logLine(s.id, 1, "vieja") });
      expect(await b.next()).toMatchObject({ type: "log", line: "vieja" });
      b.ws.close(); agent2.close();
    });

    it("una segunda pestaña recibe log_reset y la cola acumulada", async () => {
      const { s, agent } = await setup();
      const b1 = await browser();
      b1.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
      const sub = await agent.waitFor("subscribeLogs");
      agent.ack(sub.id, sub.id);
      await b1.next(); // log_reset
      for (const n of [1, 2]) agent.send({ streamId: sub.id, body: logLine(s.id, n, `l${n}`) });
      await b1.next(); await b1.next();
      const b2 = await browser();
      b2.ws.send(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` }));
      expect(await b2.next()).toEqual({ type: "log_reset", serverId: s.id });
      expect(await b2.next()).toEqual({ type: "log", serverId: s.id, ts: 1, line: "l1" });
      expect(await b2.next()).toEqual({ type: "log", serverId: s.id, ts: 2, line: "l2" });
      b1.ws.close(); b2.ws.close(); agent.close();
    });

    it("descarta líneas de un socket lento, cuenta y avisa con log_dropped; el estado no se descarta", async () => {
      const { s, agent } = await setup();
      const hub = new BrowserHub(app);
      const sock = new FakeSocket();
      hub.add(sock as never);
      for (const t of ["nodes", `server:${s.id}:logs`]) sock.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topic: t })));
      const sub = await agent.waitFor("subscribeLogs");
      agent.ack(sub.id, sub.id);
      await until(() => sock.sent.some((m) => m.type === "log_reset"));
      sock.bufferedAmount = 2 * 1024 * 1024;
      for (const n of [1, 2]) agent.send({ streamId: sub.id, body: logLine(s.id, n, `l${n}`) });
      app.events.emit("node", { id: "x", status: "online" });
      await until(() => sock.sent.some((m) => m.type === "node"));
      await until(() => (hub as unknown as { droppedFor(w: unknown, id: string): number }).droppedFor(sock, s.id) === 2);
      expect(sock.sent.filter((m) => m.type === "log")).toEqual([]);
      sock.bufferedAmount = 0;
      agent.send({ streamId: sub.id, body: logLine(s.id, 3, "l3") });
      await until(() => sock.sent.some((m) => m.type === "log"));
      const tail = sock.sent.slice(sock.sent.findIndex((m) => m.type === "log_dropped"));
      expect(tail.map((m) => m.type)).toEqual(["log_dropped", "log"]);
      expect(tail[0]).toEqual({ type: "log_dropped", serverId: s.id, count: 2 });
      hub.dispose(); agent.close();
    });

    it("reabre con backoff si el agente cierra el stream con el nodo online", async () => {
      const { s, agent } = await setup();
      const sched = new ManualScheduler();
      const hub = new BrowserHub(app, { schedule: sched.schedule });
      const sock = new FakeSocket();
      hub.add(sock as never);
      sock.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", topic: `server:${s.id}:logs` })));
      let sub = await agent.waitFor("subscribeLogs");
      agent.ack(sub.id, sub.id);
      for (const delay of [1000, 2000, 4000]) {
        await until(() => sock.sent.some((m) => m.type === "log_reset"));
        sock.sent.length = 0;
        agent.send({ streamId: sub.id, body: { case: "streamClose", value: { reason: "cerrado" } } });
        await until(() => sock.sent.some((m) => m.type === "stream_closed"));
        expect(sched.delays.at(-1)).toBe(delay);
        sched.fire();
        sub = await agent.waitFor("subscribeLogs");
        agent.ack(sub.id, sub.id);
      }
      await until(() => sock.sent.some((m) => m.type === "log_reset"));
      hub.dispose(); agent.close();
    });
  });
});

class FakeSocket extends EventEmitter {
  readyState = 1; OPEN = 1; bufferedAmount = 0; sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
}

class ManualScheduler {
  delays: number[] = [];
  private fns: (() => void)[] = [];
  schedule = (fn: () => void, ms: number) => { this.delays.push(ms); this.fns.push(fn); return () => { this.fns = this.fns.filter((f) => f !== fn); }; };
  fire() { const f = this.fns.shift(); f?.(); }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: condición no cumplida");
    await new Promise((r) => setImmediate(r));
  }
}
