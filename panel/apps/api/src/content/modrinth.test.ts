import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { openDb } from "../db/db.js";
import { PACK_MAX_BYTES, REF_UNAVAILABLE, type ContentRef } from "./adapter.js";
import { CONTENT_USER_AGENT, UpstreamClient } from "./http.js";
import { ModrinthAdapter } from "./modrinth.js";
import { ContentMetaRepo } from "./repo.js";

const API = "https://api.modrinth.com/v2";
const fixture = (name: string): object => JSON.parse(readFileSync(new URL(`./fixtures/modrinth/${name}.json`, import.meta.url), "utf8")) as object;
const proxied = (u: string) => `/api/content/image?url=${encodeURIComponent(u)}`;

function setup(rateBudgets?: Record<string, number>) {
  const f = fakeContentFetch();
  const now = () => Date.parse("2026-10-30T10:00:00Z");
  const http = new UpstreamClient({ fetch: f.fetch, now, timers: new ManualTimers(), rateBudgets });
  const repo = new ContentMetaRepo(openDb(":memory:"), now);
  return { ...f, repo, adapter: new ModrinthAdapter(http, repo) };
}
/** Counts the repo's writes: one `put` or non-empty `putMany` is one transaction. */
const writes = (repo: ContentMetaRepo) => {
  const put = vi.spyOn(repo, "put");
  const putMany = vi.spyOn(repo, "putMany");
  return () => ({ put: put.mock.calls.length, putMany: putMany.mock.calls.filter(([, rows]) => rows.length > 0).length });
};
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

  it("stores only the versions it returns, in one write, and nothing on a cache hit", async () => {
    const t = setup();
    const base = (fixture("versions") as object[])[0] as object;
    const docs = Array.from({ length: 201 }, (_, i) => ({
      ...base, id: `v${String(i).padStart(7, "0")}`, date_published: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
    }));
    t.replyWhen(isPath(`${API}/project/AANobbMI/version`), docs);
    const n = writes(t.repo);
    const r = await t.adapter.versions("AANobbMI", { kind: "mod", gameVersion: null, loaders: [] });
    expect(r.versions).toHaveLength(200);
    expect(n()).toEqual({ put: 0, putMany: 1 });
    expect(t.repo.get("modrinth", "version", "v0000200")).not.toBeNull();
    expect(t.repo.get("modrinth", "version", "v0000000")).toBeNull(); // the oldest, past the cap
    await t.adapter.versions("AANobbMI", { kind: "mod", gameVersion: null, loaders: [] });
    expect(t.calls).toHaveLength(1);
    expect(n()).toEqual({ put: 0, putMany: 1 });
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

  it("stores a batch in one write and nothing on a cache hit", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/projects`), [fixture("project"), fixture("pack-project")]);
    t.replyWhen(isPath(`${API}/teams`), [fixture("members")]);
    const n = writes(t.repo);
    await t.adapter.projects(["AANobbMI", "1KVo5zza"]);
    expect(n()).toEqual({ put: 0, putMany: 1 });
    await t.adapter.projects(["AANobbMI", "1KVo5zza"]);
    expect(n()).toEqual({ put: 0, putMany: 1 });
  });
});

describe("ModrinthAdapter.resolveRefs", () => {
  const raw = (r: string) => {
    const i = r.indexOf(":");
    return { raw: r, projectRef: i < 0 ? r : r.slice(0, i), versionRef: i < 0 ? null : r.slice(i + 1), pinned: false };
  };
  /** /v2/projects answers every requested id or slug it knows (a slug "ghost" is unknown). */
  const projectsBySlug = (t: ReturnType<typeof setup>) => {
    t.replyWhen(isPath(`${API}/projects`), (u: URL) => (JSON.parse(u.searchParams.get("ids")!) as string[])
      .filter((ref) => ref !== "ghost")
      .map((ref) => ({ ...(fixture("project") as object), id: `P${ref.replace(/\D/g, "").padStart(7, "0")}`, slug: ref })));
    t.replyWhen(isPath(`${API}/teams`), []);
  };

  it("resolves slugs in batches of 100 and caches the refs", async () => {
    const t = setup();
    projectsBySlug(t);
    const slugs = Array.from({ length: 150 }, (_, i) => `mod-${String(i).padStart(3, "0")}`);
    const w = writes(t.repo);
    const r = await t.adapter.resolveRefs([...slugs.map(raw), raw("ghost")], "mod");
    expect(r[0]).toEqual({ projectId: "P0000000", versionId: null });
    expect(r[149]).toEqual({ projectId: "P0000149", versionId: null });
    expect(r.at(-1)).toBeNull();
    const projectCalls = t.calls.filter((c) => new URL(c.url).pathname === "/v2/projects");
    expect(projectCalls.map((c) => (JSON.parse(new URL(c.url).searchParams.get("ids")!) as string[]).length)).toEqual([100, 51]);
    expect(t.repo.get("modrinth", "ref", "mod-149")?.data).toBe((r[149] as ContentRef).projectId);
    expect(w()).toEqual({ put: 0, putMany: 2 }); // both batches of projects, then every ref
    const n = t.calls.length;
    expect(await t.adapter.resolveRefs([raw("mod-001")], "mod")).toEqual([r[1]]);
    expect(t.calls).toHaveLength(n);
  });

  it("keeps a version id, looks up a version number once, and caches both refs", async () => {
    const t = setup();
    t.repo.put("modrinth", "ref", "sodium", "AANobbMI");
    t.replyWhen((u) => u.pathname === "/v2/projects", []); // "datapack-only" is unknown
    t.reply(`${API}/project/AANobbMI/version/0.5.5`, (fixture("versions") as object[])[2]!);
    const r = await t.adapter.resolveRefs([raw("sodium:0.5.5"), raw("sodium:midRel01"), raw("datapack-only")], "mod");
    expect(r.slice(0, 2)).toEqual([{ projectId: "AANobbMI", versionId: "midRel01" }, { projectId: "AANobbMI", versionId: "midRel01" }]);
    expect(r[2]).toBeNull();
    expect(t.calls.map((c) => path(c.url))).toEqual([`${API}/projects`, `${API}/project/AANobbMI/version/0.5.5`]);
    expect(t.repo.get("modrinth", "ref", "AANobbMI:0.5.5")?.data).toBe("midRel01");
  });

  it("a failing source marks the entries unavailable; a dotted segment never reaches a URL", async () => {
    const t = setup();
    expect(await t.adapter.resolveRefs([raw("sodium"), raw("..")], "mod")).toEqual([REF_UNAVAILABLE, null]);
    expect(t.calls.map((c) => JSON.parse(new URL(c.url).searchParams.get("ids")!))).toEqual([["sodium"]]);
  });
});

describe("ModrinthAdapter.latestFor", () => {
  const cur = (versionId: string, type: "release" | "beta" | "alpha") => ({
    platform: "modrinth" as const, projectId: "AANobbMI", versionId, label: versionId, type, publishedAt: "2024-01-01T00:00:00.000Z",
    gameVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], installable: true, reason: null,
  });
  const newer = (id: string, type = "release") => ({ ...(fixture("versions") as object[])[0] as object, id, version_type: type, date_published: "2024-06-01T00:00:00Z" });

  it("stores the primary file's sha1 of each version seen", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/project/AANobbMI/version`), fixture("versions"));
    await t.adapter.versions("AANobbMI", { kind: "mod", gameVersion: null, loaders: [] });
    expect(t.repo.get("modrinth", "file", "midRel01")?.data).toBe("a".repeat(40));
    expect(t.repo.get("modrinth", "file", "oldRel01")).toBeNull();
  });

  it("asks version_files/update once per channel with the target, and maps each current version", async () => {
    const t = setup();
    t.repo.put("modrinth", "file", "relVer01", "1".repeat(40));
    t.repo.put("modrinth", "file", "relVer02", "2".repeat(40));
    t.repo.put("modrinth", "file", "betVer01", "3".repeat(40));
    t.replyWhen(isPath(`${API}/version_files/update`), (_u: URL, init: { body?: string }) => {
      const body = JSON.parse(init.body!) as { hashes: string[]; version_types: string[] };
      return body.version_types.length === 1 ? { ["1".repeat(40)]: newer("relVer09") } : { ["3".repeat(40)]: newer("betVer09", "beta") };
    });
    const r = await t.adapter.latestFor([cur("relVer01", "release"), cur("relVer02", "release"), cur("betVer01", "beta")], { kind: "mod", gameVersion: "1.21.1", loaders: ["fabric", "quilt"] });
    const posts = t.calls.filter((c) => c.url === `${API}/version_files/update`);
    expect(posts.map((c) => [c.method, JSON.parse(c.body!)])).toEqual([
      ["POST", { hashes: ["1".repeat(40), "2".repeat(40)], algorithm: "sha1", loaders: ["fabric", "quilt"], game_versions: ["1.21.1"], version_types: ["release"] }],
      ["POST", { hashes: ["3".repeat(40)], algorithm: "sha1", loaders: ["fabric", "quilt"], game_versions: ["1.21.1"], version_types: ["release", "beta"] }],
    ]);
    expect(r.get("relVer01")?.versionId).toBe("relVer09");
    expect(r.get("betVer01")).toMatchObject({ versionId: "betVer09", type: "beta" });
    expect(r.has("relVer02")).toBe(true);
    expect(r.get("relVer02")).toBeNull(); // the source knows no newer compatible version
    expect(t.repo.get("modrinth", "version", "relVer09")).not.toBeNull();
  });

  it("fetches the missing hashes in one batch; what cannot be checked is left out", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/versions`), [(fixture("versions") as object[])[2]]); // midRel01 only, with its files
    t.replyWhen(isPath(`${API}/version_files/update`), "down", 503);
    const r = await t.adapter.latestFor([cur("midRel01", "release"), cur("gone0001", "release")], { kind: "datapack", gameVersion: "1.21.1", loaders: ["paper"] });
    expect(JSON.parse(new URL(t.calls[0]!.url).searchParams.get("ids")!)).toEqual(["midRel01", "gone0001"]);
    expect(JSON.parse(t.calls[1]!.body!)).toMatchObject({ hashes: ["a".repeat(40)], loaders: ["datapack"] });
    expect(r.size).toBe(0);
  });

  it("without a game version or loaders it cannot ask", async () => {
    const t = setup();
    expect((await t.adapter.latestFor([cur("relVer01", "release")], { kind: "mod", gameVersion: "1.21.1", loaders: [] })).size).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it("an exhausted request budget is a 502 with its own message", async () => {
    const t = setup({ "api.modrinth.com": 1 });
    t.replyWhen(isPath(`${API}/search`), fixture("search"));
    const q = { kind: "mod" as const, q: "", gameVersion: null, loaders: [], category: null, sort: "relevance" as const, offset: 0 };
    await t.adapter.search(q);
    await expect(t.adapter.search({ ...q, q: "x" })).rejects.toMatchObject({ status: 502, message: "Modrinth rate limit reached, try again in a minute" });
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
