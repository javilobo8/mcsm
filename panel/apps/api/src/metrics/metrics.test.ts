import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { browserClient } from "../../test/browser-client.js";

let app: FastifyInstance;
let url: string;
let cookie: string;
const dirs: string[] = [];

async function start(path = ":memory:", setup = true) {
  app = await buildApp({ db: openDb(path) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = setup
    ? await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } })
    : await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
}

// No se cierra la Db: el detach asíncrono del agente aún puede escribir en ella tras app.close().
async function stop() {
  await app.close();
}

async function enrollWithServer(): Promise<{ nodeId: string; nodeToken: string; serverId: string }> {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  const { nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json();
  const serverId = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } })).json().id;
  return { nodeId, nodeToken, serverId };
}

async function connect(nodeToken: string, serverId: string): Promise<FakeAgent> {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect({ specVersions: { [serverId]: 1n } });
  await agent.waitFor("helloAck");
  return agent;
}

const nowSlot = () => BigInt(Math.floor(Date.now() / 10_000) * 10);

/** Envía un lote fechado en la ventana actual y devuelve esa ventana. */
function sendBatch(agent: FakeAgent, serverId: string, cpuPct = 33): bigint {
  const tsUnix = nowSlot();
  agent.send({ body: { case: "metricBatch", value: {
    tsUnix,
    host: { cpuPct: 12, memUsedBytes: 4n << 30n, memTotalBytes: 16n << 30n, diskUsedBytes: 50n << 30n, diskTotalBytes: 500n << 30n },
    servers: [{ serverId, cpuPct, memBytes: 1n << 30n, memLimitBytes: 3n << 30n, mcOnline: true, playersOnline: 2, playersMax: 20, pingMs: 3 }],
  } } });
  return tsUnix;
}

/** Sondea (cediendo el turno, sin dormir) hasta que el panel haya guardado la muestra. */
async function waitForPoint(path: string): Promise<any> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const s = (await app.inject({ method: "GET", url: path, headers: { cookie } })).json();
    if (s.cpuPct?.some((v: number | null) => v !== null)) return s;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("la muestra no llegó");
}

afterEach(async () => {
  if (app) await stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("métricas (HTTP + agente)", () => {
  it("exige sesión, valida el rango y responde 404 a ids desconocidos", async () => {
    await start();
    const { nodeId, serverId } = await enrollWithServer();
    expect((await app.inject({ method: "GET", url: `/api/servers/${serverId}/metrics` })).statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: `/api/servers/${serverId}/metrics?range=30d`, headers: { cookie } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("Rango inválido: usa 1h, 24h o 7d");
    expect((await app.inject({ method: "GET", url: "/api/servers/nope/metrics", headers: { cookie } })).json()).toEqual({ error: "Servidor no encontrado" });
    expect((await app.inject({ method: "GET", url: "/api/nodes/nope/metrics", headers: { cookie } })).statusCode).toBe(404);
    const empty = (await app.inject({ method: "GET", url: `/api/nodes/${nodeId}/metrics?range=7d`, headers: { cookie } })).json();
    expect(empty).toMatchObject({ range: "7d", step: 300 });
    expect(empty.t).toHaveLength(2016);
    expect(empty.cpuPct.every((v: unknown) => v === null)).toBe(true);
  });

  it("un MetricBatch del agente se guarda y se sirve por servidor y por nodo (1h por defecto)", async () => {
    await start();
    const { nodeId, nodeToken, serverId } = await enrollWithServer();
    const agent = await connect(nodeToken, serverId);
    sendBatch(agent, serverId);
    const s = await waitForPoint(`/api/servers/${serverId}/metrics`);
    expect(s.range).toBe("1h");
    expect(s.t).toHaveLength(360);
    const i = s.cpuPct.findIndex((v: number | null) => v !== null);
    expect(s.cpuPct[i]).toBe(33);
    expect(s.memBytes[i]).toBe(1024 ** 3);
    expect(s.playersOnline[i]).toBe(2);
    const n = await waitForPoint(`/api/nodes/${nodeId}/metrics?range=24h`);
    expect(n.step).toBe(60);
    expect(n.diskTotalBytes.find((v: number | null) => v !== null)).toBe(500 * 1024 ** 3);
    agent.close();
  });

  it("el navegador suscrito a nodes recibe node_metrics en vivo", async () => {
    await start();
    const { nodeId, nodeToken, serverId } = await enrollWithServer();
    const b = await browserClient(url, cookie);
    b.ws.send(JSON.stringify({ type: "subscribe", topic: "nodes" }));
    const agent = await connect(nodeToken, serverId);
    const ts = sendBatch(agent, serverId);
    let msg: any;
    do { msg = await b.next(); } while (msg.type !== "node_metrics"); // antes llegan los "node" del Hello
    expect(msg).toEqual({ type: "node_metrics", nodeId, sample: { ts: Number(ts), cpuPct: 12, memBytes: 4 * 1024 ** 3, memTotalBytes: 16 * 1024 ** 3, diskBytes: 50 * 1024 ** 3, diskTotalBytes: 500 * 1024 ** 3 } });
    b.ws.close();
    agent.close();
  });

  it("el histórico sigue tras reiniciar el panel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcsm-metrics-"));
    dirs.push(dir);
    const path = join(dir, "panel.db");
    await start(path);
    const { nodeToken, serverId } = await enrollWithServer();
    const agent = await connect(nodeToken, serverId);
    sendBatch(agent, serverId, 44);
    await waitForPoint(`/api/servers/${serverId}/metrics`);
    agent.close();
    await stop();

    await start(path, false); // mismo fichero: login en vez de setup
    const s = (await app.inject({ method: "GET", url: `/api/servers/${serverId}/metrics`, headers: { cookie } })).json();
    expect(s.cpuPct.filter((v: number | null) => v !== null)).toEqual([44]);
  });
});
