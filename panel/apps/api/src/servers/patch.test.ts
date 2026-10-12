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
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno", spec: { type: "PAPER", memory: "4G", properties: { motd: "Hola" }, ...spec } } })).json();
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: payload as object });

describe("PATCH de spec como merge de primer nivel", () => {
  it("una sección sola no pisa el resto de la spec", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { whitelist: { enabled: true, players: ["Lobo"] } } });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.specVersion).toBe(2);
    expect(after.spec).toMatchObject({ type: "PAPER", memory: "4G", properties: { motd: "Hola" }, whitelist: { enabled: true, players: ["Lobo"] } });
    expect(after.spec.ports.game).toBe(s.spec.ports.game);
    expect(after.spec.rconPassword).toBe(s.spec.rconPassword);
  });

  it("null borra una sección; el tipo de modpack exige modpack", async () => {
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

  it("reenviar la misma spec no incrementa la versión; con nombre nuevo solo renombra", async () => {
    const s = await create();
    const { rconPassword: _r, ...same } = s.spec;
    let res = await patch(s.id, { spec: same });
    expect(res.json().specVersion).toBe(1);
    res = await patch(s.id, { name: "Otro nombre", spec: same });
    expect(res.json()).toMatchObject({ name: "Otro nombre", specVersion: 1 });
  });

  it("no se puede cambiar rconPassword por PATCH", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { rconPassword: "hackhackhack" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.rconPassword).toBe(s.spec.rconPassword);
    expect(res.json().specVersion).toBe(1);
  });

  it("ports sin game conserva el puerto de juego", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { ports: { extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.ports).toEqual({ game: s.spec.ports.game, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] });
  });

  it("errores con la ruta del campo y cuerpos inválidos", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { mods: { modrinthProjects: ["con espacio"] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^mods\.modrinthProjects\.0: /);
    res = await patch(s.id, { spec: "x" });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie, "content-type": "application/json" }, payload: '{"spec":{"__proto__":{"type":"FORGE"}}}' });
    expect(res.statusCode).toBe(400);
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });
});

describe("PATCH: ausente, null y [] en ops/whitelist", () => {
  it("[] deja la sección presente y vacía, ausente no la toca y null la elimina", async () => {
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
