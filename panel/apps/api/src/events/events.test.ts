import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { EventLevel } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { EventsRepo } from "./repo.js";

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

const connect = async () => {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  await app.agents.get(nodeId)!.ready;
  return agent;
};
const createServer = async (name: string) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name, desiredState: "running" } })).json();
const getEvents = async (query = "") => app.inject({ method: "GET", url: `/api/events${query}`, headers: { cookie } });
const waitEvents = async (n: number, query = "") => {
  await vi.waitFor(async () => expect((await getEvents(query)).json()).toHaveLength(n));
  return (await getEvents(query)).json();
};
const sendEvent = (agent: FakeAgent, value: { level: EventLevel; serverId?: string; kind: string; message: string; tsUnixMs?: bigint }) =>
  agent.send({ body: { case: "event", value: { serverId: "", tsUnixMs: BigInt(Date.now()), ...value } } });

describe("eventos del agente", () => {
  it("guarda nivel, tipo, servidor (con su nombre) y hora del agente, y lo publica", async () => {
    const s = await createServer("Uno");
    const agent = await connect();
    const published = new Promise((resolve) => app.events.once("server_event", resolve));
    sendEvent(agent, { level: EventLevel.WARN, serverId: s.id, kind: "crash", message: "El servidor se ha cerrado con el código 1 (1 en la última hora)" });
    const [ev] = await waitEvents(1);
    expect(ev).toMatchObject({ nodeId, serverId: s.id, serverName: "Uno", level: "warn", kind: "crash", message: expect.stringContaining("código 1") });
    expect(ev.agentAt).toMatch(/Z$/);
    expect(await published).toMatchObject({ id: ev.id, kind: "crash" });
    agent.close();
  });

  it("descarta servidores ajenos y niveles sin especificar; recorta, normaliza y acepta eventos del nodo", async () => {
    const agent = await connect();
    sendEvent(agent, { level: EventLevel.WARN, serverId: "de-otro-nodo", kind: "crash", message: "x" });
    sendEvent(agent, { level: EventLevel.UNSPECIFIED, kind: "crash", message: "x" });
    sendEvent(agent, { level: EventLevel.INFO, kind: "Raro!", message: "m".repeat(2000), tsUnixMs: 1n });
    const [ev] = await waitEvents(1);
    expect(ev).toMatchObject({ serverId: null, serverName: null, level: "info", kind: "other", agentAt: null });
    expect(ev.message).toHaveLength(1000);
    agent.close();
  });

  it("crash_loop deja el servidor deseado en parado", async () => {
    const s = await createServer("Uno");
    const agent = await connect();
    sendEvent(agent, { level: EventLevel.ERROR, serverId: s.id, kind: "crash_loop", message: "Bucle de crash" });
    await waitEvents(1);
    const row = (await app.inject({ method: "GET", url: `/api/servers/${s.id}`, headers: { cookie } })).json();
    expect(row.desiredState).toBe("stopped");
    expect(row.specVersion).toBe(s.specVersion); // sin versión nueva
    agent.close();
  });
});

describe("GET /api/events", () => {
  it("filtra por servidor y nivel mínimo, pagina y exige sesión", async () => {
    const s = await createServer("Uno");
    const rec = (level: "info" | "warn" | "error", serverId: string | null) =>
      app.eventsService.record({ nodeId, serverId, level, kind: "drift", message: level });
    const a = rec("info", s.id);
    const b = rec("warn", null);
    const c = rec("error", s.id);
    expect((await getEvents()).json().map((e: { id: string }) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await getEvents("?minLevel=warn")).json().map((e: { id: string }) => e.id)).toEqual([c.id, b.id]);
    expect((await getEvents(`?serverId=${s.id}`)).json().map((e: { id: string }) => e.id)).toEqual([c.id, a.id]);
    expect((await getEvents("?limit=1")).json()).toHaveLength(1);
    expect((await getEvents(`?before=${encodeURIComponent(c.createdAt)}`)).json().every((e: { createdAt: string }) => e.createdAt < c.createdAt)).toBe(true);
    expect((await getEvents("?minLevel=debug")).statusCode).toBe(400);
    expect((await getEvents("?limit=0")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(401);
  });

  it("purga lo de más de 30 días y deja como mucho el máximo", () => {
    const repo = new EventsRepo(app.db);
    const row = (id: string, created: string) => ({ id, node_id: null, server_id: null, server_name: null, level: "info" as const, kind: "x", message: "m", agent_at: null, created_at: created });
    repo.insert(row("viejo", "2026-01-01T00:00:00.000Z"));
    for (const id of ["a", "b", "c"]) repo.insert(row(id, `2026-10-13T00:00:0${"abc".indexOf(id)}.000Z`));
    expect(repo.purge("2026-09-13T00:00:00.000Z", 2)).toBe(2); // el viejo y el más antiguo de los que sobran
    expect(repo.list({ limit: 10 }).map((r) => r.id)).toEqual(["c", "b"]);
  });
});
