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

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const fullSpec = {
  type: "FABRIC", version: "1.21.4", imageTag: "java21", memory: "3G",
  mods: { modrinthProjects: ["lithium", "fabric-api"] },
  properties: { motd: "Plantilla", difficulty: "hard" },
  whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"],
  env: { USE_AIKAR_FLAGS: "true" }, resources: { cpus: 2, memLimit: "4G" }, restartPolicy: "always",
  ports: { game: 25580, extra: [{ host: 24454, container: 24454, proto: "udp", label: "Voice" }] },
};

describe("plantillas", () => {
  it("guardar como plantilla quita puertos y rconPassword; instanciar reproduce el servidor salvo nombre, puertos y RCON", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Original", spec: fullSpec })).json();
    let res = await req("POST", "/api/templates", { name: "Fabric optimizado", description: "Con lithium", fromServerId: server.id });
    expect(res.statusCode).toBe(201);
    const tpl = res.json();
    expect(tpl).toMatchObject({ name: "Fabric optimizado", description: "Con lithium", sourceServerId: server.id });
    expect(tpl.spec).not.toHaveProperty("ports");
    expect(tpl.spec).not.toHaveProperty("rconPassword");
    expect(JSON.stringify(tpl)).not.toContain(server.spec.rconPassword);

    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "Copia" });
    expect(res.statusCode).toBe(201);
    const copy = res.json();
    expect(copy.name).toBe("Copia");
    expect(copy.slug).toBe("copia");
    expect(copy.spec.ports).toEqual({ game: 25565, extra: [] });
    expect(copy.spec.rconPassword).toHaveLength(43);
    expect(copy.spec.rconPassword).not.toBe(server.spec.rconPassword);
    const strip = (s: Record<string, unknown>) => { const { ports: _p, rconPassword: _r, ...rest } = s; return rest; };
    expect(strip(copy.spec)).toEqual(strip(server.spec));
  });

  it("instanciar con puerto explícito; puerto ocupado da 409", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Vanilla", spec: { type: "VANILLA" } })).json();
    let res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "A", port: 25590, desiredState: "running" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ desiredState: "running", spec: { ports: { game: 25590 } } });
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "B", port: 25590 });
    expect(res.statusCode).toBe(409);
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId: "no-existe", name: "C" });
    expect(res.statusCode).toBe(404);
  });

  it("crear desde spec descarta puertos y rconPassword y valida igual que un servidor", async () => {
    let res = await req("POST", "/api/templates", { name: "Con puertos", spec: { ...fullSpec, rconPassword: "secretosecreto" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec).not.toHaveProperty("ports");
    expect(res.json().spec).not.toHaveProperty("rconPassword");
    res = await req("POST", "/api/templates", { name: "Mala", spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await req("POST", "/api/templates", { name: "Nada" });
    expect(res.statusCode).toBe(400);
  });

  it("nombres únicos, PATCH con merge, duplicar y borrar", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Base", spec: { type: "PAPER", memory: "4G" } })).json();
    expect((await req("POST", "/api/templates", { name: "Base", spec: {} })).statusCode).toBe(409);

    let res = await req("PATCH", `/api/templates/${tpl.id}`, { description: "Nueva", spec: { ops: ["Lobo"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Base", description: "Nueva", spec: { type: "PAPER", memory: "4G", ops: ["Lobo"] } });
    res = await req("PATCH", `/api/templates/${tpl.id}`, { spec: { ops: null } });
    expect(res.json().spec).not.toHaveProperty("ops");

    const d1 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    const d2 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    expect([d1.name, d2.name]).toEqual(["Base (copia)", "Base (copia 2)"]);
    expect(d1.spec).toEqual(res.json().spec);
    expect((await req("PATCH", `/api/templates/${d1.id}`, { name: "Base" })).statusCode).toBe(409);

    expect((await req("GET", "/api/templates")).json().map((t: { name: string }) => t.name)).toEqual(["Base", "Base (copia 2)", "Base (copia)"]); // orden por nombre (NOCASE)
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(204);
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(404);
    expect((await req("GET", `/api/templates/${d2.id}`)).statusCode).toBe(404);
  });

  it("borrar el servidor de origen deja la plantilla con sourceServerId null", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Origen" })).json();
    const tpl = (await req("POST", "/api/templates", { name: "De origen", fromServerId: server.id })).json();
    expect((await req("DELETE", `/api/servers/${server.id}`)).statusCode).toBe(204);
    expect((await req("GET", `/api/templates/${tpl.id}`)).json().sourceServerId).toBeNull();
  });

  it("requiere sesión", async () => {
    expect((await app.inject({ method: "GET", url: "/api/templates" })).statusCode).toBe(401);
  });
});

describe("PATCH de plantilla: null en claves obligatorias", () => {
  it("responde 400 y conserva la spec", async () => {
    const { ports: _p, ...spec } = fullSpec;
    const tpl = (await req("POST", "/api/templates", { name: "T", spec })).json();
    const res = await req("PATCH", `/api/templates/${tpl.id}`, { spec: { type: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("«type»");
    expect((await req("GET", `/api/templates/${tpl.id}`)).json().spec.type).toBe("FABRIC");
    expect((await req("PATCH", `/api/templates/${tpl.id}`, { spec: { whitelist: null } })).json().spec).not.toHaveProperty("whitelist");
  });
});
