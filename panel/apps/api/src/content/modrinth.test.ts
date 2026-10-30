import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { openDb } from "../db/db.js";
import { PACK_MAX_BYTES } from "./adapter.js";
import { CONTENT_USER_AGENT, UpstreamClient } from "./http.js";
import { ModrinthAdapter } from "./modrinth.js";
import { ContentMetaRepo } from "./repo.js";

const API = "https://api.modrinth.com/v2";
const fixture = (name: string): object => JSON.parse(readFileSync(new URL(`./fixtures/modrinth/${name}.json`, import.meta.url), "utf8")) as object;
const proxied = (u: string) => `/api/content/image?url=${encodeURIComponent(u)}`;

function setup() {
  const f = fakeContentFetch();
  const now = () => Date.parse("2026-10-30T10:00:00Z");
  const http = new UpstreamClient({ fetch: f.fetch, now, timers: new ManualTimers() });
  const repo = new ContentMetaRepo(openDb(":memory:"), now);
  return { ...f, repo, adapter: new ModrinthAdapter(http, repo) };
}
const path = (u: string) => { const x = new URL(u); return x.origin + x.pathname; };
const isPath = (p: string) => (u: URL) => u.origin + u.pathname === p;

describe("ModrinthAdapter.search", () => {
  it("searches mods with loader, version and server-side facets", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), fixture("search"));
    await t.adapter.search({ kind: "mod", q: "sodium", gameVersion: "1.21.1", loaders: ["quilt", "fabric"], category: null, sort: "downloads", offset: 20 });
    const u = new URL(t.calls[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.modrinth.com/v2/search");
    expect(JSON.parse(u.searchParams.get("facets")!)).toEqual([["project_type:mod"], ["categories:quilt", "categories:fabric"], ["versions:1.21.1"], ["server_side!=unsupported"]]);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ query: "sodium", index: "downloads", offset: "20", limit: "20" });
    expect(t.calls[0]!.headers["user-agent"]).toBe(CONTENT_USER_AGENT);
  });

  it("omits empty facets and adds the category", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), fixture("search"));
    await t.adapter.search({ kind: "datapack", q: "", gameVersion: null, loaders: [], category: "worldgen", sort: "relevance", offset: 0 });
    const u = new URL(t.calls[0]!.url);
    expect(JSON.parse(u.searchParams.get("facets")!)).toEqual([["project_type:datapack"], ["server_side!=unsupported"], ["categories:worldgen"]]);
    expect(u.searchParams.get("index")).toBe("relevance");
  });

  it("hides client-only hits even if the facet is ignored", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), fixture("search"));
    const r = await t.adapter.search({ kind: "mod", q: "", gameVersion: null, loaders: [], category: null, sort: "relevance", offset: 20 });
    expect(r.hits.map((h) => h.projectId)).toEqual(["AANobbMI", "P7dR8mSH"]);
    expect(r).toMatchObject({ total: 123, offset: 20, limit: 20, stale: false });
    expect(r.hits[0]).toEqual({
      platform: "modrinth", projectId: "AANobbMI", slug: "sodium", name: "Sodium", author: "jellysquid3", summary: "Rendering engine",
      iconUrl: proxied("https://cdn.modrinth.com/data/AANobbMI/icon.png"), downloads: 1000, categories: ["fabric", "optimization"],
    });
  });

  it("returns proxied icons", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), fixture("search"));
    const r = await t.adapter.search({ kind: "mod", q: "", gameVersion: null, loaders: [], category: null, sort: "relevance", offset: 0 });
    expect(r.hits[0]!.iconUrl!.startsWith("/api/content/image?url=")).toBe(true);
    expect(r.hits[1]!.iconUrl).toBeNull();
  });

  it("maps 429 to a rate-limit message", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), "slow down", 429);
    await expect(t.adapter.search({ kind: "mod", q: "", gameVersion: null, loaders: [], category: null, sort: "relevance", offset: 0 }))
      .rejects.toMatchObject({ name: "HttpError", status: 502, message: "Modrinth is rate limiting the panel: try again in a minute" });
  });

  it("a 200 with another shape is a 502, not a 500", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/search`), { hits: "nope" });
    await expect(t.adapter.search({ kind: "mod", q: "", gameVersion: null, loaders: [], category: null, sort: "relevance", offset: 0 }))
      .rejects.toMatchObject({ name: "HttpError", status: 502, message: "Could not query Modrinth" });
  });
});

describe("ModrinthAdapter.categories", () => {
  it("keeps the categories of the kind, labelled, without icons", async () => {
    const t = setup();
    t.reply(`${API}/tag/category`, fixture("categories"));
    expect(await t.adapter.categories("mod")).toEqual([{ id: "world-generation", label: "World generation" }, { id: "optimization", label: "Optimization" }]);
    expect(await t.adapter.categories("modpack")).toEqual([{ id: "kitchen-sink", label: "Kitchen sink" }]);
    expect(t.calls).toHaveLength(1);
  });
});

describe("ModrinthAdapter.project", () => {
  it("maps the project with a sanitised description, proxied gallery and safe links", async () => {
    const t = setup();
    t.reply(`${API}/project/AANobbMI`, fixture("project"));
    t.reply(`${API}/project/AANobbMI/members`, fixture("members"));
    const p = await t.adapter.project("AANobbMI");
    expect(p).toMatchObject({
      platform: "modrinth", projectId: "AANobbMI", slug: "sodium", name: "Sodium", author: "jellysquid3", downloads: 1000,
      gallery: [proxied("https://cdn.modrinth.com/data/AANobbMI/images/g.png")], pageUrl: "https://modrinth.com/mod/sodium",
      clientOnly: false, distributable: true,
      links: [{ label: "Source", url: "https://github.com/CaffeineMC/sodium" }, { label: "Issues", url: "https://github.com/CaffeineMC/sodium/issues" }],
    });
    expect(p.descriptionHtml).toContain("<h1>Sodium</h1>");
    expect(p.descriptionHtml).not.toContain("<script");
    expect(p.descriptionHtml).toContain(proxied("https://cdn.modrinth.com/data/AANobbMI/images/a.png"));
  });

  it("an unknown project is a 404", async () => {
    const t = setup();
    t.reply(`${API}/project/zzzzzzzz`, "not found", 404);
    await expect(t.adapter.project("zzzzzzzz")).rejects.toMatchObject({ status: 404, message: "Project not found on Modrinth" });
  });
});

describe("ModrinthAdapter.versions", () => {
  it("maps versions newest first with dependencies", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/project/AANobbMI/version`), fixture("versions"));
    const r = await t.adapter.versions("AANobbMI", { kind: "mod", gameVersion: "1.21.1", loaders: ["fabric"] });
    const u = new URL(t.calls[0]!.url);
    expect(JSON.parse(u.searchParams.get("loaders")!)).toEqual(["fabric"]);
    expect(JSON.parse(u.searchParams.get("game_versions")!)).toEqual(["1.21.1"]);
    expect(u.searchParams.get("include_changelog")).toBe("false");
    expect(r.stale).toBe(false);
    expect(r.versions.map((v) => v.versionId)).toEqual(["newBeta1", "midRel01", "oldRel01"]);
    expect(r.versions[0]).toEqual({
      platform: "modrinth", projectId: "AANobbMI", versionId: "newBeta1", label: "0.6.0-beta.1", type: "beta",
      publishedAt: "2024-03-01T08:00:00.123Z", gameVersions: ["1.21.1"], loaders: ["fabric", "quilt"],
      dependencies: [
        { projectId: "P7dR8mSH", versionId: null, type: "required" },
        { projectId: null, versionId: "IrisVer1", type: "optional" },
        { projectId: null, versionId: null, type: "incompatible" },
      ],
      installable: true, reason: null,
    });
    expect(t.repo.get("modrinth", "version", "midRel01")).not.toBeNull();
  });

  it("omits empty filters", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/project/AANobbMI/version`), []);
    await t.adapter.versions("AANobbMI", { kind: "mod", gameVersion: null, loaders: [] });
    const u = new URL(t.calls[0]!.url);
    expect([...u.searchParams.keys()]).toEqual(["include_changelog"]);
  });

  it("datapack versions filter by the datapack loader", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/project/AANobbMI/version`), []);
    await t.adapter.versions("AANobbMI", { kind: "datapack", gameVersion: "1.21.1", loaders: ["paper"] });
    expect(JSON.parse(new URL(t.calls[0]!.url).searchParams.get("loaders")!)).toEqual(["datapack"]);
  });

  it("batches versionsByIds in groups of 100", async () => {
    const t = setup();
    const ids = Array.from({ length: 150 }, (_, i) => `v${String(i).padStart(7, "0")}`);
    const version = (id: string) => ({ ...(fixture("versions") as object[])[0] as object, id });
    t.replyWhen(isPath(`${API}/versions`), []);
    t.reply(`${API}/versions?ids=${encodeURIComponent(JSON.stringify(ids.slice(0, 100)))}`, ids.slice(0, 100).map(version));
    t.reply(`${API}/versions?ids=${encodeURIComponent(JSON.stringify(ids.slice(100)))}`, ids.slice(100).map(version));
    const vs = await t.adapter.versionsByIds([...ids, "../bad"]);
    expect(t.calls.map((c) => path(c.url))).toEqual([`${API}/versions`, `${API}/versions`]);
    expect(JSON.parse(new URL(t.calls[0]!.url).searchParams.get("ids")!)).toHaveLength(100);
    expect(JSON.parse(new URL(t.calls[1]!.url).searchParams.get("ids")!)).toHaveLength(50);
    expect(vs).toHaveLength(150);
  });
});

describe("ModrinthAdapter.projects", () => {
  it("maps project meta with the team owner, in batches", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/projects`), [fixture("project"), fixture("pack-project")]);
    t.replyWhen(isPath(`${API}/teams`), [fixture("members")]);
    const ps = await t.adapter.projects(["AANobbMI", "1KVo5zza"]);
    expect(ps).toEqual([
      { projectId: "AANobbMI", slug: "sodium", name: "Sodium", author: "jellysquid3", iconUrl: proxied("https://cdn.modrinth.com/data/AANobbMI/icon.png"), clientOnly: false, distributable: true },
      { projectId: "1KVo5zza", slug: "fabulously-optimized", name: "Fabulously Optimized", author: "", iconUrl: proxied("https://cdn.modrinth.com/data/1KVo5zza/icon.png"), clientOnly: false, distributable: true },
    ]);
    expect(t.repo.get("modrinth", "project", "AANobbMI")?.data).toMatchObject({ name: "Sodium" });
  });
});

describe("ModrinthAdapter.resolveRef", () => {
  it("resolves a slug entry to the project id and caches the ref", async () => {
    const t = setup();
    t.reply(`${API}/project/sodium`, fixture("project"));
    const e = { raw: "sodium", projectRef: "sodium", versionRef: null, pinned: false };
    expect(await t.adapter.resolveRef(e, "mod")).toEqual({ projectId: "AANobbMI", versionId: null });
    expect(await t.adapter.resolveRef(e, "mod")).toEqual({ projectId: "AANobbMI", versionId: null });
    expect(t.calls.map((c) => c.url)).toEqual([`${API}/project/sodium`]);
    expect(t.repo.get("modrinth", "ref", "sodium")?.data).toBe("AANobbMI");
  });

  it("resolves a version number through the project", async () => {
    const t = setup();
    t.reply(`${API}/project/sodium`, fixture("project"));
    t.reply(`${API}/project/AANobbMI/version/0.5.5`, (fixture("versions") as object[])[2]!);
    const e = { raw: "sodium:0.5.5", projectRef: "sodium", versionRef: "0.5.5", pinned: false };
    expect(await t.adapter.resolveRef(e, "mod")).toEqual({ projectId: "AANobbMI", versionId: "midRel01" });
    expect(t.repo.get("modrinth", "version", "midRel01")).not.toBeNull();
  });

  it("an unknown project is null; a dotted segment never reaches a URL", async () => {
    const t = setup();
    t.reply(`${API}/project/nope`, "", 404);
    expect(await t.adapter.resolveRef({ raw: "nope", projectRef: "nope", versionRef: null, pinned: false }, "mod")).toBeNull();
    expect(await t.adapter.resolveRef({ raw: "..", projectRef: "..", versionRef: null, pinned: false }, "mod")).toBeNull();
    expect(t.calls).toHaveLength(1);
  });
});

describe("ModrinthAdapter.pack", () => {
  const MRPACK = "https://cdn.modrinth.com/data/1KVo5zza/versions/FoPack01/fo.mrpack";
  const index = {
    formatVersion: 1, game: "minecraft", versionId: "5.0.1", name: "FO",
    dependencies: { minecraft: "1.21.1", "fabric-loader": "0.16.9" },
    files: [
      { path: "mods/sodium.jar", hashes: { sha1: "a".repeat(40) }, env: { client: "required", server: "required" }, downloads: [], fileSize: 1 },
      { path: "mods/fabric-api.jar", hashes: { sha1: "b".repeat(40) }, downloads: [], fileSize: 1 },
      { path: "mods/zoomify.jar", hashes: { sha1: "c".repeat(40) }, env: { client: "required", server: "unsupported" }, downloads: [], fileSize: 1 },
      { path: "mods/sodium-extra.jar", hashes: { sha1: "d".repeat(40) }, downloads: [], fileSize: 1 },
    ],
  };
  const packSetup = () => {
    const t = setup();
    t.reply(`${API}/version/FoPack01`, fixture("pack-version"));
    t.reply(`${API}/project/1KVo5zza`, fixture("pack-project"));
    return t;
  };

  it("reads a pack's contents through the hash lookup", async () => {
    const t = packSetup();
    t.reply(MRPACK, zipSync({ "modrinth.index.json": strToU8(JSON.stringify(index)) }));
    t.reply(`${API}/version_files`, {
      ["a".repeat(40)]: { id: "SodVer01", project_id: "AANobbMI" },
      ["b".repeat(40)]: { id: "FabVer01", project_id: "P7dR8mSH" },
      ["d".repeat(40)]: { id: "SodVer02", project_id: "AANobbMI" },
    });
    const p = await t.adapter.pack("1KVo5zza", "FoPack01");
    expect(p).toEqual({
      platform: "modrinth", projectId: "1KVo5zza", slug: "fabulously-optimized", versionId: "FoPack01", name: "Fabulously Optimized",
      versionLabel: "5.0.1", iconUrl: proxied("https://cdn.modrinth.com/data/1KVo5zza/icon.png"), minecraftVersion: "1.21.1",
      loader: "fabric", loaderVersion: "0.16.9",
      contents: [{ platform: "modrinth", projectId: "AANobbMI" }, { platform: "modrinth", projectId: "P7dR8mSH" }],
      contentsKnown: true, reason: null,
    });
    const post = t.calls.find((c) => c.url === `${API}/version_files`)!;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body!)).toEqual({ hashes: ["a".repeat(40), "b".repeat(40), "d".repeat(40)], algorithm: "sha1" });
    // Stored: a second read does not touch the network.
    const n = t.calls.length;
    expect(await t.adapter.pack("1KVo5zza", "FoPack01")).toEqual(p);
    expect(t.calls).toHaveLength(n);
  });

  it("marks an oversized pack as contentsKnown: false", async () => {
    const t = packSetup();
    t.reply(MRPACK, "x", 200, { "content-length": String(PACK_MAX_BYTES + 1) });
    expect(await t.adapter.pack("1KVo5zza", "FoPack01")).toMatchObject({
      contentsKnown: false, reason: "The pack is too large to inspect (over 64 MiB)", contents: [],
      minecraftVersion: "1.21.1", loader: "fabric", loaderVersion: null, versionLabel: "5.0.1",
    });
  });

  it("an unreadable pack has unknown contents", async () => {
    const t = packSetup();
    t.reply(MRPACK, zipSync({ "a.txt": strToU8("x") }));
    expect(await t.adapter.pack("1KVo5zza", "FoPack01")).toMatchObject({ contentsKnown: false, reason: "Could not read the pack's file list" });
  });

  it("a version of another project is a 404", async () => {
    const t = setup();
    t.reply(`${API}/version/FoPack01`, fixture("pack-version"));
    await expect(t.adapter.pack("AANobbMI", "FoPack01")).rejects.toMatchObject({ status: 404 });
  });
});
