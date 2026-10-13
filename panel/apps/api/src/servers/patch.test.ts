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

const create = async (spec: object = {}) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "One", spec: { type: "PAPER", memory: "4G", properties: { motd: "Hola" }, ...spec } } })).json();
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: payload as object });

describe("spec PATCH as a first-level merge", () => {
  it("a single section does not overwrite the rest of the spec", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { whitelist: { enabled: true, players: ["Lobo"] } } });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.specVersion).toBe(2);
    expect(after.spec).toMatchObject({ type: "PAPER", memory: "4G", properties: { motd: "Hola" }, whitelist: { enabled: true, players: ["Lobo"] } });
    expect(after.spec.ports.game).toBe(s.spec.ports.game);
    expect(after.spec.rconPassword).toBe(s.spec.rconPassword);
  });

  it("null deletes a section; the modpack type requires modpack", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await patch(s.id, { spec: { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "" });
    res = await patch(s.id, { spec: { type: "PAPER", modpack: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).not.toHaveProperty("modpack");
    expect(res.json().specVersion).toBe(3);
  });

  it("resending the same spec does not increment the version; with a new name it only renames", async () => {
    const s = await create();
    const { rconPassword: _r, ...same } = s.spec;
    let res = await patch(s.id, { spec: same });
    expect(res.json().specVersion).toBe(1);
    res = await patch(s.id, { name: "Other name", spec: same });
    expect(res.json()).toMatchObject({ name: "Other name", specVersion: 1 });
  });

  it("rconPassword cannot be changed via PATCH", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { rconPassword: "hackhackhack" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.rconPassword).toBe(s.spec.rconPassword);
    expect(res.json().specVersion).toBe(1);
  });

  it("ports without game keeps the game port", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { ports: { extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.ports).toEqual({ game: s.spec.ports.game, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] });
  });

  it("errors with the field path and invalid bodies", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { mods: { modrinthProjects: ["with space"] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^mods\.modrinthProjects\.0: /);
    res = await patch(s.id, { spec: "x" });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie, "content-type": "application/json" }, payload: '{"spec":{"__proto__":{"type":"FORGE"}}}' });
    expect(res.statusCode).toBe(400);
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });
});

describe("PATCH: absent, null and [] in ops/whitelist", () => {
  it("[] leaves the section present and empty, absent does not touch it and null removes it", async () => {
    const s = await create();
    expect(s.spec).not.toHaveProperty("ops");
    let res = await patch(s.id, { spec: { ops: [] } });
    expect(res.json().spec.ops).toEqual([]);
    expect(res.json().specVersion).toBe(2);
    res = await patch(s.id, { spec: { memory: "5G" } });
    expect(res.json().spec.ops).toEqual([]);
    res = await patch(s.id, { spec: { ops: null } });
    expect(res.json().spec).not.toHaveProperty("ops");
    expect(res.json().specVersion).toBe(4);
  });
});

describe("PATCH: null on required keys", () => {
  it("responds 400 naming the key and resets nothing (a FABRIC does not become PAPER)", async () => {
    const s = await create({ type: "FABRIC" });
    for (const k of ["type", "version", "memory", "ports", "properties", "env", "resources", "restartPolicy", "imageTag"]) {
      const res = await patch(s.id, { spec: { [k]: null } });
      expect(res.statusCode, k).toBe(400);
      expect(res.json().error, k).toContain(`“${k}”`);
    }
    const row = app.servers.get(s.id)!;
    expect(row.spec_version).toBe(1);
    expect(JSON.parse(row.spec).type).toBe("FABRIC");
    // Optional sections do get deleted with null.
    expect((await patch(s.id, { spec: { ops: [] } })).statusCode).toBe(200);
    expect((await patch(s.id, { spec: { ops: null, mods: null } })).statusCode).toBe(200);
  });
});

describe("PATCH: 64 KiB cap on the spec after the merge", () => {
  const bigEnv = (prefix: string) => Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${prefix}${i}`, "x".repeat(4000)]));
  it("each PATCH fits, but the resulting spec does not: clear 400 and the stored spec does not change", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { env: bigEnv("A") } });
    expect(res.statusCode).toBe(200);
    res = await patch(s.id, { spec: { properties: Object.fromEntries(Object.entries(bigEnv("p")).map(([k, v]) => [k.toLowerCase(), v])) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/64 KiB/);
    expect(app.servers.get(s.id)!.spec_version).toBe(2);
  });
  it("also on create", async () => {
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Grande", spec: { env: { ...bigEnv("A"), ...bigEnv("B") } } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/64 KiB/);
  });
});
