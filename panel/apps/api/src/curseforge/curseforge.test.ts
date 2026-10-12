import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { migrate, openDb } from "../db/db.js";
import { migrations } from "../db/migrations.js";
import { FakeAgent } from "../../test/fake-agent.js";

const KEY = "$2a$10$abcdefghijklmnopqrstuv";

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

const putKey = (apiKey: string) => app.inject({ method: "PUT", url: "/api/settings/curseforge", headers: { cookie }, payload: { apiKey } });
const createServer = async (name: string, spec: object) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name, spec } })).json();
const cfSpec = { type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10" } };
const specOf = (env: Envelope) => {
  if (env.body.case !== "applySpec") throw new Error(`esperaba applySpec, llegó ${env.body.case}`);
  return { version: env.body.value.server!.version, serverId: env.body.value.server!.serverId, spec: JSON.parse(new TextDecoder().decode(env.body.value.server!.specJson)) };
};

describe("API key de CurseForge", () => {
  it("GET/PUT nunca devuelven la key; valida el formato", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } })).json()).toEqual({ configured: false });
    let res = await putKey(KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true });
    res = await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true });
    expect(res.body).not.toContain(KEY);
    expect((await putKey("con espacio")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge" })).statusCode).toBe(401);
    expect((await putKey("")).json()).toEqual({ configured: false });
  });

  it("la key es ASCII imprimible sin espacios (1-200); se recorta y \"\" la borra", async () => {
    for (const bad of ["nul\u0000", "esc\u001b[0m", "del\u007f", "clé", "a b", "k".repeat(201)]) {
      const res = await putKey(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.body).not.toContain(bad);
    }
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } })).json()).toEqual({ configured: false });
    expect((await putKey("k".repeat(200))).json()).toEqual({ configured: true });
    expect((await putKey(`  ${KEY}\n`)).json()).toEqual({ configured: true });
    expect(app.curseforge.get()).toBe(KEY);
    expect((await putKey("  ")).json()).toEqual({ configured: false });
  });

  it("solo viaja al agente en specs que usan CurseForge y nunca al navegador", async () => {
    await putKey(KEY);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const cfP = createServer("Pack", cfSpec);
    const a1 = await agent.waitFor("applySpec");
    agent.ack(a1.id);
    const cf = await cfP;
    expect(specOf(a1).spec.curseforgeApiKey).toBe(KEY);

    const paperP = createServer("Paper", { type: "PAPER" });
    const a2 = await agent.waitFor("applySpec");
    agent.ack(a2.id);
    await paperP;
    expect(specOf(a2).spec).not.toHaveProperty("curseforgeApiKey");

    for (const u of ["/api/servers", `/api/servers/${cf.id}`]) {
      const body = (await app.inject({ method: "GET", url: u, headers: { cookie } })).body;
      expect(body).not.toContain(KEY);
      expect(body).not.toContain("curseforgeApiKey");
    }
    expect(app.servers.get(cf.id)!.spec).not.toContain(KEY);
    agent.close();
  });

  it("cambiar la key reaplica solo los servidores de CurseForge; la misma key no hace nada", async () => {
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER", mods: { curseforgeFiles: [] } });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [cf.id]: 1n, [paper.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const put = putKey(KEY);
    const apply = specOf(await agent.waitFor("applySpec"));
    expect(apply).toMatchObject({ serverId: cf.id, version: 2n });
    expect(apply.spec.curseforgeApiKey).toBe(KEY);
    expect((await put).statusCode).toBe(200);
    expect(app.servers.get(paper.id)!.spec_version).toBe(1);

    await putKey(KEY);
    expect(app.servers.get(cf.id)!.spec_version).toBe(2);

    const clear = putKey("");
    const cleared = specOf(await agent.waitFor("applySpec"));
    expect(cleared.version).toBe(3n);
    expect(cleared.spec).not.toHaveProperty("curseforgeApiKey");
    await clear;
    agent.close();
  });

  it("el SyncSpecs tras Hello incluye la key en los servidores de CurseForge", async () => {
    await putKey(KEY);
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    const sync = await agent.waitFor("syncSpecs");
    if (sync.body.case !== "syncSpecs") throw new Error();
    const byId = Object.fromEntries(sync.body.value.servers.map((s) => [s.serverId, JSON.parse(new TextDecoder().decode(s.specJson))]));
    expect(byId[cf.id].curseforgeApiKey).toBe(KEY);
    expect(byId[paper.id]).not.toHaveProperty("curseforgeApiKey");
    agent.ack(sync.id);
    agent.close();
  });
});

describe("migración 020_cf_api_key_env_to_settings", () => {
  it("mueve CF_API_KEY del env libre a Ajustes y versiona la spec", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const idx = migrations.findIndex((m) => m.name === "020_cf_api_key_env_to_settings");
    expect(idx).toBeGreaterThan(0);
    for (const m of migrations.slice(0, idx)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, "t");
    }
    db.prepare("INSERT INTO nodes (id, name, token_hash, created_at) VALUES ('n', 'nas', 'h', 't')").run();
    const withKey = JSON.stringify({ type: "PAPER", env: { CF_API_KEY: KEY, USE_AIKAR_FLAGS: "true" } });
    const without = JSON.stringify({ type: "PAPER", env: { USE_AIKAR_FLAGS: "true" } });
    const ins = db.prepare("INSERT INTO servers (id, node_id, name, slug, spec, spec_version, created_at, updated_at) VALUES (?, 'n', ?, ?, ?, 4, ?, 't')");
    ins.run("a", "A", "a", withKey, "2026-01-01");
    ins.run("b", "B", "b", without, "2026-01-02");
    migrate(db);
    const rows = db.prepare("SELECT id, spec, spec_version FROM servers ORDER BY id").all() as { id: string; spec: string; spec_version: number }[];
    expect(JSON.parse(rows[0]!.spec).env).toEqual({ USE_AIKAR_FLAGS: "true" });
    expect(rows[0]!.spec_version).toBe(5);
    expect(rows[1]!.spec_version).toBe(4);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'curseforge_api_key'").get()).toEqual({ value: KEY });
  });
});
