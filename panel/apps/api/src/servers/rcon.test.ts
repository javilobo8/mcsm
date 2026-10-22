import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const post = (payload: object) => app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload });
const make = (name: string, ports: object) => post({ nodeId, name, spec: { ports } });
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: payload as object });
const putRouter = (payload: object) => app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload });

describe("publishing RCON per server", () => {
  it("is off by default: the spec has no ports.rcon", async () => {
    const s = (await make("One", {})).json();
    expect(s.spec.ports).not.toHaveProperty("rcon");
  });

  it("\"auto\" assigns a free port of the range other than the game port (allocated in the same call)", async () => {
    const res = await make("One", { rcon: "auto" });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.ports).toMatchObject({ game: 25565, rcon: 25566 });
    const two = (await make("Two", { rcon: "auto" })).json();
    expect(two.spec.ports).toMatchObject({ game: 25567, rcon: 25568 });
  });

  it("\"auto\" avoids the spec's own extras and the router's port", async () => {
    await putRouter({ enabled: true, port: 25566 });
    const s = (await make("One", { game: 25565, extra: [{ host: 25567, container: 8100, proto: "tcp" }], rcon: "auto" })).json();
    expect(s.spec.ports.rcon).toBe(25568);
  });

  it("\"auto\" avoids ports reserved by an incoming migration", async () => {
    const other = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "b" } })).json().token;
    const b = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: other, nameHint: "b", agentVersion: "fake" } })).json().nodeId;
    const res = await post({ nodeId: b, name: "Moving", spec: { ports: { game: 25565, rcon: 25566 } } });
    expect(res.statusCode).toBe(201);
    const src = res.json();
    app.jobs.create({ id: "m1", type: "migrate", serverId: src.id, nodeId: b, status: "running" });
    app.migrations.insert({
      id: "m1", server_id: src.id, source_node_id: b, target_node_id: nodeId, source_slug: "moving", target_slug: "moving",
      source_version: 1, target_version: 2, target_port: 25565, target_spec: JSON.stringify(src.spec), was_running: 0, delete_source: 0,
    });
    // The node is busy with the migration (the API refuses to create there): ask the allocator and the check directly.
    expect(app.serversService.allocatePort(nodeId)).toBe(25567);
    expect(() => app.serversService.checkPorts(nodeId, { ...src.spec, ports: { game: 25570, extra: [], rcon: 25566 } })).toThrow(/reserved by a migration/);
  });

  it("keeps an explicit number", async () => {
    const res = await make("One", { rcon: 25590 });
    expect(res.json().spec.ports).toMatchObject({ game: 25565, rcon: 25590 });
  });

  it("409 if the port is another server's game, extra or rcon port", async () => {
    await make("A", { game: 25570, extra: [{ host: 25580, container: 8100, proto: "udp" }], rcon: 25571 });
    for (const rcon of [25570, 25580, 25571]) {
      const res = await make("B", { rcon });
      expect(res.statusCode, String(rcon)).toBe(409);
      expect(res.json().error).toMatch(new RegExp(`Port ${rcon} is already used by another server`));
    }
  });

  it("a game or extra port that is another server's rcon port is a 409 too", async () => {
    await make("A", { game: 25570, rcon: 25571 });
    expect((await make("B", { game: 25571 })).statusCode).toBe(409);
    expect((await make("C", { extra: [{ host: 25571, container: 8100, proto: "tcp" }] })).statusCode).toBe(409);
  });

  it("409 if the port is the node's router port", async () => {
    await putRouter({ enabled: true, port: 25590 });
    const res = await make("A", { rcon: 25590 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/router/);
  });

  it("400 if it repeats the game port", async () => {
    const res = await make("A", { game: 25570, rcon: 25570 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/RCON port/);
  });

  it("PATCH turns it on, changes it and turns it off (ports is replaced as a whole section)", async () => {
    const s = (await make("A", { game: 25570 })).json();
    let res = await patch(s.id, { spec: { ports: { game: 25570, extra: [], rcon: "auto" } } });
    expect(res.json().spec.ports.rcon).toBe(25565);
    expect(res.json().specVersion).toBe(2);
    res = await patch(s.id, { spec: { ports: { game: 25570, extra: [], rcon: 25599 } } });
    expect(res.json().spec.ports.rcon).toBe(25599);
    // Sending the same number again is not a change.
    res = await patch(s.id, { spec: { ports: { game: 25570, extra: [], rcon: 25599 } } });
    expect(res.json().specVersion).toBe(3);
    // Omitting rcon unpublishes it.
    res = await patch(s.id, { spec: { ports: { game: 25570, extra: [] } } });
    expect(res.json().spec.ports).not.toHaveProperty("rcon");
    expect(res.json().specVersion).toBe(4);
  });

  it("PATCH with \"auto\" on a server that already publishes re-allocates a free port", async () => {
    const s = (await make("A", { game: 25570, rcon: 25571 })).json();
    const res = await patch(s.id, { spec: { ports: { game: 25570, extra: [], rcon: "auto" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.ports.rcon).toBe(25565);
  });

  it("the listing and the detail expose ports.rcon", async () => {
    const s = (await make("A", { rcon: 25590 })).json();
    const list = (await app.inject({ method: "GET", url: "/api/servers", headers: { cookie } })).json();
    expect(list.find((x: { id: string }) => x.id === s.id).spec.ports.rcon).toBe(25590);
    const one = (await app.inject({ method: "GET", url: `/api/servers/${s.id}`, headers: { cookie } })).json();
    expect(one.spec.ports.rcon).toBe(25590);
  });

  it("a router port cannot be set on a port a server publishes as RCON", async () => {
    await make("A", { rcon: 25590 });
    const res = await putRouter({ enabled: true, port: 25590 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is used by server “A”/);
  });
});
