import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { ContentCatalog } from "./catalog.js";
import { ContentMetaRepo } from "./repo.js";

const MODRINTH = "https://api.modrinth.com/v2";
const CF = "https://api.curseforge.com/v1";
const IMG = "https://cdn.modrinth.com/data/AANobbMI/icon.png";
let app: FastifyInstance;
let cookie: string;
let f: ReturnType<typeof fakeContentFetch>;
let key: string | null;

beforeEach(async () => {
  f = fakeContentFetch();
  key = null;
  const db = openDb(":memory:");
  const now = () => Date.parse("2026-10-30T10:00:00Z");
  app = await buildApp({
    db, content: new ContentCatalog({ repo: new ContentMetaRepo(db, now), curseforgeKey: () => key, fetch: f.fetch, now, timers: new ManualTimers() }),
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

const get = (url: string, withCookie = true) => app.inject({ method: "GET", url, headers: withCookie ? { cookie } : {} });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { cookie, ...headers } });
const isPath = (p: string) => (u: URL) => u.origin + u.pathname === p;

describe("/api/content", () => {
  it("requires a session", async () => {
    for (const url of ["/api/content/modrinth/search?kind=mod", `/api/content/image?url=${encodeURIComponent(IMG)}`]) {
      expect((await get(url, false)).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/content/lookup", payload: { entries: [] } })).statusCode).toBe(401);
    expect(f.calls).toEqual([]);
  });

  it("validates before touching the network", async () => {
    for (const url of ["/api/content/modrinth/projects/..%2F..%2Fetc/versions?kind=mod",
                       "/api/content/curseforge/projects/abc",
                       "/api/content/modrinth/search?kind=shader",
                       "/api/content/modrinth/search?kind=mod&gameVersion=1.21%0A",
                       "/api/content/github/search?kind=mod",
                       "/api/content/modrinth/packs/AANobbMI/..",
                       "/api/content/curseforge/packs/1/x",
                       "/api/content/modrinth/categories?kind=mod&x=1",
                       "/api/content/modrinth/search?kind=mod&evil=1"]) {
      expect([400, 404], url).toContain((await get(url)).statusCode);
    }
    expect((await get("/api/content/github/search?kind=mod")).json()).toEqual({ error: "Not found" });
    expect((await get("/api/content/curseforge/projects/abc")).json()).toEqual({ error: "Invalid project id" });
    expect(f.calls).toEqual([]);
  });

  it("searches Modrinth", async () => {
    f.replyWhen(isPath(`${MODRINTH}/search`), { hits: [], offset: 0, limit: 20, total_hits: 0 });
    const res = await get("/api/content/modrinth/search?kind=mod&q=sodium&gameVersion=1.21.1&loaders=fabric,quilt");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hits: [], total: 0, offset: 0, limit: 20, stale: false });
    expect(JSON.parse(new URL(f.calls[0]!.url).searchParams.get("facets")!)[1]).toEqual(["categories:fabric", "categories:quilt"]);
  });

  it("lists categories and versions", async () => {
    f.reply(`${MODRINTH}/tag/category`, [{ name: "magic", project_type: "mod", header: "categories" }]);
    expect((await get("/api/content/modrinth/categories?kind=mod")).json()).toEqual({ categories: [{ id: "magic", label: "Magic" }] });
    f.replyWhen(isPath(`${MODRINTH}/project/sodium/version`), []);
    expect((await get("/api/content/modrinth/projects/sodium/versions?kind=mod")).json()).toEqual({ versions: [], stale: false });
  });

  it("CurseForge without a key answers 409 with the Settings hint", async () => {
    for (const url of ["/api/content/curseforge/search?kind=mod", "/api/content/curseforge/projects/238222", "/api/content/curseforge/packs/1/2"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(409);
      expect(res.json()).toEqual({ error: "Save a CurseForge API key in Settings to browse CurseForge" });
    }
    expect(f.calls).toEqual([]);
  });

  it("POST /api/content/resolve with a foreign Origin is 403", async () => {
    const body = { list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: ["fabric"] }, selections: [{ projectId: "AANobbMI", versionId: "SodVer01" }], present: [], pack: null };
    expect((await post("/api/content/resolve", body, { origin: "http://evil.example" })).statusCode).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it("lookup caps entries at 1000", async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({ list: "mods.modrinthProjects", entry: `p${i}` }));
    expect((await post("/api/content/lookup", { entries })).statusCode).toBe(400);
    expect(f.calls).toEqual([]);
    const ok = await post("/api/content/lookup", { entries: [{ list: "mods.curseforgeFiles", entry: "1:2" }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ entries: [{ raw: "1:2", resolved: false }] });
  });

  it("updates answers per entry", async () => {
    const res = await post("/api/content/updates", { list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: [] }, entries: ["AANobbMI:SodVer01"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updates: [{ entry: "AANobbMI:SodVer01", projectId: null, currentVersionId: null, compatible: true, latest: null }] });
  });

  it("never returns the CurseForge key", async () => {
    key = "cf-secret";
    f.replyWhen(isPath(`${CF}/mods/search`), "forbidden", 403);
    f.replyWhen(isPath(`${CF}/mods/238222`), { data: { id: 238222, name: "JEI", slug: "jei", downloadCount: 1, links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/jei" } } });
    f.replyWhen(isPath(`${CF}/mods/238222/description`), { data: "<p>cf-secret? no</p>" });
    const responses = [
      await get("/api/content/curseforge/search?kind=mod"),
      await get("/api/content/curseforge/projects/238222"),
      await post("/api/content/lookup", { entries: [{ list: "mods.curseforgeFiles", entry: "238222:5101" }] }),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([502, 200, 200]);
    expect(responses[1]!.json()).toMatchObject({ name: "JEI" });
    // The description is the project's own text; nothing the panel adds carries the key.
    for (const r of [responses[0]!, responses[2]!]) expect(r.body).not.toContain("cf-secret");
    expect(JSON.stringify(responses[1]!.json()).replace("cf-secret? no", "")).not.toContain("cf-secret");
    expect(f.calls.every((c) => !c.url.includes("cf-secret"))).toBe(true);
  });
});

describe("GET /api/content/image", () => {
  it("refuses hosts outside the allowlist with 400 and no fetch", async () => {
    for (const u of ["https://evil.example/a.png", "http://cdn.modrinth.com/a.png", "file:///etc/passwd"]) {
      const res = await get(`/api/content/image?url=${encodeURIComponent(u)}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Image host not allowed" });
    }
    expect((await get("/api/content/image")).statusCode).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it("serves the bytes with locked-down headers, from cache the second time", async () => {
    f.reply(IMG, new Uint8Array([137, 80, 78, 71]), 200, { "content-type": "image/png" });
    const url = `/api/content/image?url=${encodeURIComponent(IMG)}`;
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(res.headers).toMatchObject({
      "content-type": "image/png", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect((await get(url)).statusCode).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("refuses SVG with 502", async () => {
    f.reply(IMG, "<svg onload='x'/>", 200, { "content-type": "image/svg+xml" });
    const res = await get(`/api/content/image?url=${encodeURIComponent(IMG)}`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Unsupported image type" });
  });
});
