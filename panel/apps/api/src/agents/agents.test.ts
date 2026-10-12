import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { create } from "@bufbuild/protobuf";
import { DesiredState, HelloSchema, ObservedSchema, ServerObservedSchema, LogLineSchema } from "@mcsm/proto";
import { AgentHub } from "./hub.js";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { specSchema } from "@mcsm/shared";

let app: FastifyInstance;
let url: string;
let cookie: string;

async function enrollNode(name = "nas"): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

const baseSpec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

describe("agent hub", () => {
  it("rechaza tokens inválidos", async () => {
    const agent = new FakeAgent(url, "nope");
    await expect(agent.connect()).rejects.toThrow(/401/);
  });

  it("Hello → HelloAck + SyncSpecs con lo que falta, y marca el nodo online/offline", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const s2 = app.servers.create({ nodeId, name: "Dos", slug: "dos", spec: { ...baseSpec, ports: { game: 25566, extra: [] } }, desiredState: "stopped" });
    app.servers.updateSpec(s2.id, { ...baseSpec, ports: { game: 25567, extra: [] } }); // s2 pasa a versión 2

    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s2.id]: 2n, "zombie-id": 1n } });
    const ack = await agent.waitFor("helloAck");
    expect(ack.body.case === "helloAck" && ack.body.value.nodeId).toBe(nodeId);

    const sync = await agent.waitFor("syncSpecs");
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.servers.map((s) => s.serverId)).toEqual([s1.id]); // s2 ya está al día
    expect(sync.body.value.removedIds).toEqual(["zombie-id"]);
    expect(sync.body.value.servers[0]!.slug).toBe("uno");
    expect(sync.body.value.servers[0]!.version).toBe(1n);
    agent.ack(sync.id);

    await new Promise((r) => setTimeout(r, 50));
    let node = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json()[0];
    expect(node.status).toBe("online");
    expect(node.agentVersion).toBe("fake");
    expect(app.agents.isOnline(nodeId)).toBe(true);

    agent.close();
    await new Promise((r) => setTimeout(r, 100));
    node = (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json()[0];
    expect(node.status).toBe("offline");
  });

  it("SyncSpecs incluye también las specs cuyo estado deseado difiere del del agente", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const s2 = app.servers.create({ nodeId, name: "Dos", slug: "dos", spec: { ...baseSpec, ports: { game: 25566, extra: [] } }, desiredState: "stopped" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({
      specVersions: { [s1.id]: 1n, [s2.id]: 1n },
      desiredStates: { [s1.id]: DesiredState.RUNNING, [s2.id]: DesiredState.RUNNING }, // s2 derivó en el agente
    });
    const sync = await agent.handshake();
    if (sync.body.case !== "syncSpecs") throw new Error();
    expect(sync.body.value.servers.map((s) => s.serverId)).toEqual([s2.id]);
    expect(sync.body.value.servers[0]!.desiredState).toBe(DesiredState.STOPPED);
  });

  it("ServerObserved actualiza la BD y emite evento", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [s1.id]: 1n } });
    await agent.waitFor("helloAck");
    const seen = new Promise<any>((resolve) => app.events.once("observed", (id, obs) => resolve({ id, obs })));
    agent.send({ body: { case: "serverObserved", value: create(ServerObservedSchema, {
      serverId: s1.id, tsUnixMs: BigInt(Date.now()),
      observed: create(ObservedSchema, { containerId: "abc", state: "running", health: "healthy", appliedVersion: 1n, mc: { online: true, playersOnline: 2, playersMax: 10, version: "1.21.4", latencyMs: 3 } }),
    }) } });
    const ev = await seen;
    expect(ev.id).toBe(s1.id);
    expect(ev.obs.state).toBe("running");
    const row = app.servers.get(s1.id)!;
    expect(row.observed_spec_version).toBe(1);
    expect(JSON.parse(row.observed!).mc.playersOnline).toBe(2);
  });

  it("request() resuelve con la respuesta del mismo id y falla con Error", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    const conn = app.agents.get(nodeId)!;
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 2000);
    const req = await agent.waitFor("powerAction");
    agent.ack(req.id);
    expect((await p).body.case).toBe("ack");
    const p2 = conn.request({ case: "sendCommand", value: { serverId: "x", command: "list" } }, 2000);
    const req2 = await agent.waitFor("sendCommand");
    agent.send({ id: req2.id, body: { case: "error", value: { code: "rcon_failed", message: "sin conexión" } } });
    await expect(p2).rejects.toMatchObject({ code: "rcon_failed", message: "sin conexión" });
  });
  it("openStream no pierde el primer LogLine enviado en el mismo tick que el Ack", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    const conn = app.agents.get(nodeId)!;
    const lines: string[] = [];
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 200 } }, (e) => {
      if (e.body.case === "logLine") lines.push(e.body.value.line);
    }, () => {});
    const req = await agent.waitFor("subscribeLogs");
    // Ack y primera línea de log seguidos, sin ceder el control entre ambos.
    agent.ack(req.id, req.id);
    agent.send({ streamId: req.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: "x", tsUnixMs: 1n, line: "primera" }) } });
    agent.send({ streamId: req.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: "x", tsUnixMs: 2n, line: "segunda" }) } });
    await opened;
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual(["primera", "segunda"]);
  });

  it("openStream borra el stream si la petición falla", async () => {
    const { nodeId, nodeToken } = await enrollNode();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    const conn = app.agents.get(nodeId)!;
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 1 } }, () => {}, () => {});
    const req = await agent.waitFor("subscribeLogs");
    agent.send({ id: req.id, body: { case: "error", value: { code: "unknown_server", message: "no existe" } } });
    await expect(opened).rejects.toMatchObject({ code: "unknown_server" });
    expect((conn as unknown as { streams: Map<bigint, unknown> }).streams.size).toBe(0);
  });
});

describe("AgentConn.ready: nada sale al agente antes del Ack de SyncSpecs", () => {
  async function syncing() {
    const { nodeId, nodeToken } = await enrollNode();
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    const sync = await agent.waitFor("syncSpecs");
    return { nodeId, agent, sync, conn: app.agents.get(nodeId)! };
  }

  it("las peticiones esperan al Ack y salen en orden", async () => {
    const { agent, sync, conn } = await syncing();
    let ready = false;
    void conn.ready.then(() => { ready = true; });
    const p1 = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 5000);
    const p2 = conn.request({ case: "sendCommand", value: { serverId: "x", command: "list" } }, 5000);
    await expect(agent.next(150)).rejects.toThrow(/sin mensaje/);
    expect(ready).toBe(false);
    agent.ack(sync.id);
    await agent.waitFor("backupList"); // inventario que el panel pide solo tras cada Hello (Plan 4), antes que estas
    const r1 = await agent.next();
    const r2 = await agent.next();
    expect([r1.body.case, r2.body.case]).toEqual(["powerAction", "sendCommand"]);
    expect(ready).toBe(true);
    agent.ack(r1.id);
    agent.send({ id: r2.id, body: { case: "commandResult", value: { output: "ok" } } });
    expect((await p1).body.case).toBe("ack");
    expect((await p2).body.case).toBe("commandResult");
  });

  it("openStream también espera al Ack de SyncSpecs", async () => {
    const { agent, sync, conn } = await syncing();
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 0 } }, () => {}, () => {});
    await expect(agent.next(150)).rejects.toThrow(/sin mensaje/);
    agent.ack(sync.id);
    const req = await agent.waitFor("subscribeLogs");
    agent.ack(req.id, req.id);
    expect((await opened).streamId).toBe(req.id);
  });

  it("si el plazo vence antes del Ack la petición falla con syncing y no llega a salir", async () => {
    const { agent, sync, conn } = await syncing();
    await expect(conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 100)).rejects.toMatchObject({ code: "syncing" });
    agent.ack(sync.id);
    await agent.waitFor("backupList"); // la del inventario (Plan 4) sí sale
    await expect(agent.next(150)).rejects.toThrow(/sin mensaje/);
  });

  it("si SyncSpecs falla se cierra la conexión y ready se rechaza", async () => {
    const { agent, sync, conn } = await syncing();
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 5000);
    agent.send({ id: sync.id, body: { case: "error", value: { code: "apply_failed", message: "boom" } } });
    await expect(conn.ready).rejects.toMatchObject({ code: "disconnected" });
    await expect(p).rejects.toMatchObject({ code: "disconnected" });
    const end = Date.now() + 2000;
    while (!agent.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(agent.closed).toBe(true);
  });
});

describe("robustez del hub", () => {
  async function connected(name = "nas") {
    const { nodeId, nodeToken } = await enrollNode(name);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    return { nodeId, nodeToken, agent, conn: app.agents.get(nodeId)! };
  }
  const waitUntil = async (fn: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(fn()).toBe(true);
  };

  it("un Hello de un nodo borrado cierra la conexión sin promesas sin manejar", async () => {
    const { nodeId, agent } = await connected();
    app.nodes.delete(nodeId);
    agent.send({ id: 1n, body: { case: "hello", value: create(HelloSchema, { agentVersion: "x" }) } });
    await waitUntil(() => agent.closed);
  });

  it("DELETE /api/nodes/:id desconecta al agente vivo", async () => {
    const { nodeId, agent } = await connected();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    await waitUntil(() => agent.closed);
    expect(app.agents.isOnline(nodeId)).toBe(false);
  });

  it("un callback o listener que lanza no tumba el proceso ni cierra la conexión", async () => {
    const { agent, conn } = await connected();
    const frames: string[] = [];
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 0 } }, (e) => {
      if (e.body.case === "logLine") { frames.push(e.body.value.line); throw new Error("boom"); }
    }, () => {});
    const req = await agent.waitFor("subscribeLogs");
    agent.ack(req.id, req.id);
    await opened;
    const log = (line: string) => agent.send({ streamId: req.id, body: { case: "logLine", value: create(LogLineSchema, { serverId: "x", tsUnixMs: 1n, line }) } });
    log("a"); log("b");
    await waitUntil(() => frames.length === 2);
    const listener = () => { throw new Error("listener"); };
    app.agents.on("message", listener);
    agent.send({ id: 77n, body: { case: "serverObserved", value: create(ServerObservedSchema, { serverId: "nada" }) } });
    await new Promise((r) => setTimeout(r, 50));
    app.agents.off("message", listener);
    expect(agent.closed).toBe(false);
    expect(app.agents.isOnline(conn.nodeId)).toBe(true);
  });

  it("un mensaje no solicitado con el id de una petición pendiente no la consume", async () => {
    const { nodeId, nodeToken, agent, conn } = await connected();
    const s1 = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec: baseSpec, desiredState: "running" });
    void nodeToken;
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 2000);
    const req = await agent.waitFor("powerAction");
    const seen = new Promise((resolve) => app.events.once("observed", (id) => resolve(id)));
    agent.send({ id: req.id, body: { case: "serverObserved", value: create(ServerObservedSchema, { serverId: s1.id, observed: create(ObservedSchema, { state: "running", appliedVersion: 1n }) }) } });
    expect(await seen).toBe(s1.id);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    agent.ack(req.id);
    expect((await p).body.case).toBe("ack");
  });

  it("un Error con streamId != 0 y el id de la petición rechaza openStream al instante", async () => {
    const { agent, conn } = await connected();
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 1 } }, () => {}, () => {});
    const req = await agent.waitFor("subscribeLogs");
    agent.send({ id: req.id, streamId: req.id, body: { case: "error", value: { code: "unknown_server", message: "no existe" } } });
    await expect(opened).rejects.toMatchObject({ code: "unknown_server" });
  });

  it("una segunda conexión del mismo nodo termina la vieja y su close tardío no desregistra la nueva", async () => {
    const { nodeId, nodeToken, agent: a1 } = await connected();
    const a2 = new FakeAgent(url, nodeToken);
    await a2.connect();
    await a2.waitFor("helloAck");
    await waitUntil(() => a1.closed);
    await new Promise((r) => setTimeout(r, 100));
    expect(app.agents.isOnline(nodeId)).toBe(true);
    expect(app.nodes.get(nodeId)!.status).toBe("online");
    a2.close();
  });

  it("al cerrar el socket se rechazan las pendientes y se cierran los streams", async () => {
    const { nodeId, agent, conn } = await connected();
    const reasons: string[] = [];
    const opened = conn.openStream({ case: "subscribeLogs", value: { serverId: "x", tail: 0 } }, () => {}, (r) => reasons.push(r));
    const sub = await agent.waitFor("subscribeLogs");
    agent.ack(sub.id, sub.id);
    await opened;
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 5000);
    const assertion = expect(p).rejects.toMatchObject({ code: "disconnected" });
    await agent.waitFor("powerAction");
    agent.close();
    await assertion;
    await waitUntil(() => reasons.length === 1);
    expect(app.agents.isOnline(nodeId)).toBe(false);
    await expect(conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } })).rejects.toMatchObject({ code: "disconnected" });
  });

  it("ServerObserved de un servidor de otro nodo se ignora", async () => {
    const { agent } = await connected("uno");
    const other = await enrollNode("dos");
    const foreign = app.servers.create({ nodeId: other.nodeId, name: "Ajeno", slug: "ajeno", spec: baseSpec, desiredState: "running" });
    let emitted = false;
    app.events.once("observed", () => { emitted = true; });
    agent.send({ body: { case: "serverObserved", value: create(ServerObservedSchema, { serverId: foreign.id, observed: create(ObservedSchema, { state: "running" }) }) } });
    await new Promise((r) => setTimeout(r, 100));
    expect(emitted).toBe(false);
    expect(app.servers.get(foreign.id)!.observed).toBeNull();
  });

  it("protobuf malformado se ignora y la conexión sigue viva", async () => {
    const { agent, conn } = await connected();
    agent.sendRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 0x80]));
    const p = conn.request({ case: "powerAction", value: { serverId: "x", action: 1 } }, 2000);
    const req = await agent.waitFor("powerAction");
    agent.ack(req.id);
    expect((await p).body.case).toBe("ack");
  });
});

describe("heartbeat del agente", () => {
  it("hace terminate() tras 45 s sin actividad y los pings y mensajes cuentan como actividad", () => {
    vi.useFakeTimers();
    try {
      let t = 0;
      const hub = new AgentHub({ now: () => t, idleTimeoutMs: 45_000, checkIntervalMs: 5_000 });
      const socket = new EventEmitter() as EventEmitter & { terminate(): void; send(): void; readyState: number; OPEN: number };
      let terminated = false;
      socket.terminate = () => { terminated = true; socket.emit("close"); };
      socket.send = () => {};
      socket.OPEN = 1;
      socket.readyState = 1;
      const detached: string[] = [];
      hub.on("detached", (id: string) => detached.push(id));
      hub.attach("n1", socket as unknown as WebSocket);

      t = 40_000; vi.advanceTimersByTime(40_000);
      expect(terminated).toBe(false);
      socket.emit("ping"); // actividad a los 40 s
      t = 80_000; vi.advanceTimersByTime(40_000);
      expect(terminated).toBe(false);
      socket.emit("message", Buffer.alloc(0)); // actividad a los 80 s (mensaje ilegible, igual cuenta)
      t = 120_000; vi.advanceTimersByTime(40_000);
      expect(terminated).toBe(false);
      t = 126_000; vi.advanceTimersByTime(6_000); // 46 s desde la última actividad
      expect(terminated).toBe(true);
      expect(detached).toEqual(["n1"]);
      expect(hub.isOnline("n1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ids de las peticiones del panel", () => {
  function fakeSocket() {
    const socket = new EventEmitter() as EventEmitter & { terminate(): void; send(): void; readyState: number; OPEN: number };
    socket.terminate = () => { socket.emit("close"); };
    socket.send = () => {};
    socket.OPEN = 1;
    socket.readyState = 1;
    return socket as unknown as WebSocket;
  }

  it("no se repiten entre sesiones del mismo nodo: un mensaje que cita un id de la sesión anterior no coincide con la nueva", () => {
    const hub = new AgentHub({ firstId: 100n });
    const c1 = hub.attach("n1", fakeSocket());
    expect(c1.send({ case: "helloAck", value: {} })).toBe(100n);
    const { id, response } = c1.requestTracked({ case: "backupList", value: { serverId: "" } }, 1000);
    response.catch(() => {}); // la sesión se reemplaza enseguida: disconnected
    expect(id).toBe(101n);
    const c2 = hub.attach("n1", fakeSocket()); // reemplaza a la primera
    expect(c2.send({ case: "helloAck", value: {} })).toBe(102n);
  });

  it("cada proceso del panel empieza en un punto aleatorio (lo que el agente aún tenga en cola de un panel anterior no coincide)", () => {
    const firsts = new Set(Array.from({ length: 8 }, () => new AgentHub().attach("n", fakeSocket()).send({ case: "helloAck", value: {} })));
    expect(firsts.size).toBe(8);
    for (const id of firsts) {
      expect(id).toBeGreaterThan(1n); // 0: no solicitado; 1: el Hello del agente
      expect(id).toBeLessThan(2n ** 53n); // margen hasta 2^53 aunque el proceso viva años
    }
  });
});
