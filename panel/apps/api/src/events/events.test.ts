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

describe("agent events", () => {
  it("stores level, kind, server (with its name) and agent time, and publishes it", async () => {
    const s = await createServer("One");
    const agent = await connect();
    const published = new Promise((resolve) => app.events.once("server_event", resolve));
    sendEvent(agent, { level: EventLevel.WARN, serverId: s.id, kind: "crash", message: "The server exited with code 1 (1 in the last hour)" });
    const [ev] = await waitEvents(1);
    expect(ev).toMatchObject({ nodeId, serverId: s.id, serverName: "One", level: "warn", kind: "crash", message: expect.stringContaining("code 1") });
    expect(ev.agentAt).toMatch(/Z$/);
    expect(await published).toMatchObject({ id: ev.id, kind: "crash" });
    agent.close();
  });

  it("discards foreign servers and unspecified levels; trims, normalizes and accepts node events", async () => {
    const agent = await connect();
    sendEvent(agent, { level: EventLevel.WARN, serverId: "from-another-node", kind: "crash", message: "x" });
    sendEvent(agent, { level: EventLevel.UNSPECIFIED, kind: "crash", message: "x" });
    sendEvent(agent, { level: EventLevel.INFO, kind: "Raro!", message: "m".repeat(2000), tsUnixMs: 1n });
    const [ev] = await waitEvents(1);
    expect(ev).toMatchObject({ serverId: null, serverName: null, level: "info", kind: "other", agentAt: null });
    expect(ev.message).toHaveLength(1000);
    agent.close();
  });

  it("discards a real server from ANOTHER node (and does not change its desired state)", async () => {
    const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "other" } })).json().token;
    const other = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "other", agentVersion: "fake" } })).json();
    const foreign = (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId: other.nodeId, name: "Ajeno", desiredState: "running" } })).json();
    const agent = await connect();
    sendEvent(agent, { level: EventLevel.ERROR, serverId: foreign.id, kind: "crash_loop", message: "not mine" });
    sendEvent(agent, { level: EventLevel.INFO, kind: "drift", message: "marker" }); // they are processed in order
    const evs = await waitEvents(1);
    expect(evs[0]).toMatchObject({ kind: "drift", serverId: null });
    const row = (await app.inject({ method: "GET", url: `/api/servers/${foreign.id}`, headers: { cookie } })).json();
    expect(row.desiredState).toBe("running");
    agent.close();
  });

  it("crash_loop leaves the server's desired state stopped", async () => {
    const s = await createServer("One");
    const agent = await connect();
    sendEvent(agent, { level: EventLevel.ERROR, serverId: s.id, kind: "crash_loop", message: "Crash loop" });
    await waitEvents(1);
    const row = (await app.inject({ method: "GET", url: `/api/servers/${s.id}`, headers: { cookie } })).json();
    expect(row.desiredState).toBe("stopped");
    expect(row.specVersion).toBe(s.specVersion); // no new version
    agent.close();
  });
});

describe("late crash_loop", () => {
  it("does not undo a Start later than the event's time, but does undo an earlier one", async () => {
    const s = await createServer("One");
    const agent = await connect();
    app.servers.setDesiredState(s.id, "stopped");
    app.servers.setDesiredState(s.id, "running"); // the user's “Start”, now
    const desired = async () => (await app.inject({ method: "GET", url: `/api/servers/${s.id}`, headers: { cookie } })).json().desiredState;
    sendEvent(agent, { level: EventLevel.ERROR, serverId: s.id, kind: "crash_loop", message: "viejo", tsUnixMs: BigInt(Date.now() - 60_000) });
    await waitEvents(1); // stored, but with no effect on the desired state
    expect(await desired()).toBe("running");
    sendEvent(agent, { level: EventLevel.ERROR, serverId: s.id, kind: "crash_loop", message: "nuevo", tsUnixMs: BigInt(Date.now() + 5_000) });
    await waitEvents(2);
    expect(await desired()).toBe("stopped");
    agent.close();
  });
});

describe("GET /api/events", () => {
  it("filters by server and minimum level, paginates and requires a session", async () => {
    const s = await createServer("One");
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
    const first = (await getEvents("?limit=1")).json()[0];
    expect((await getEvents(`?limit=5&before=${encodeURIComponent(first.createdAt)}&beforeId=${first.id}`)).json().map((e: { id: string }) => e.id)).toEqual([b.id, a.id]);
    expect((await getEvents("?minLevel=debug")).statusCode).toBe(400);
    expect((await getEvents("?limit=0")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(401);
  });

  it("paginates with a cursor (before, beforeId) without losing events from the same millisecond", () => {
    const repo = new EventsRepo(app.db);
    const same = "2026-10-13T00:00:00.000Z";
    for (const id of ["a", "b", "c", "d", "e"]) repo.insert({ id, node_id: null, server_id: null, server_name: null, level: "info", kind: "x", message: "m", agent_at: null, created_at: same });
    const page1 = repo.list({ limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(["e", "d"]);
    const page2 = repo.list({ limit: 2, before: same, beforeId: "d" });
    expect(page2.map((r) => r.id)).toEqual(["c", "b"]);
    expect(repo.list({ limit: 2, before: same, beforeId: "b" }).map((r) => r.id)).toEqual(["a"]);
    expect(repo.list({ limit: 5, before: same }).map((r) => r.id)).toEqual([]); // without beforeId: strictly earlier
  });

  it("purges anything older than 30 days and leaves at most the maximum", () => {
    const repo = new EventsRepo(app.db);
    const row = (id: string, created: string) => ({ id, node_id: null, server_id: null, server_name: null, level: "info" as const, kind: "x", message: "m", agent_at: null, created_at: created });
    repo.insert(row("viejo", "2026-01-01T00:00:00.000Z"));
    for (const id of ["a", "b", "c"]) repo.insert(row(id, `2026-10-13T00:00:0${"abc".indexOf(id)}.000Z`));
    expect(repo.purge("2026-09-13T00:00:00.000Z", 2)).toBe(2); // the old one and the oldest of the surplus
    expect(repo.list({ limit: 10 }).map((r) => r.id)).toEqual(["c", "b"]);
  });
});
