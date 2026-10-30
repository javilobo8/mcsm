import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { openDb } from "../db/db.js";
import { REF_UNAVAILABLE, type SearchInput } from "./adapter.js";
import { CURSEFORGE_KEY_REJECTED, CurseForgeAdapter, NO_KEY_MESSAGE, NOT_DISTRIBUTABLE } from "./curseforge.js";
import { UpstreamClient } from "./http.js";
import { ContentMetaRepo } from "./repo.js";

const API = "https://api.curseforge.com/v1";
const fixture = (name: string): object => JSON.parse(readFileSync(new URL(`./fixtures/curseforge/${name}.json`, import.meta.url), "utf8")) as object;
const proxied = (u: string) => `/api/content/image?url=${encodeURIComponent(u)}`;
const isPath = (p: string) => (u: URL) => u.origin + u.pathname === p;
const q = (over: Partial<SearchInput>): SearchInput => ({ kind: "mod", q: "", gameVersion: null, loaders: [], category: null, sort: "relevance", offset: 0, ...over });

function setup(opts: { key?: string | null } = {}) {
  const f = fakeContentFetch();
  const now = () => Date.parse("2026-10-30T10:00:00Z");
  const errors: string[] = [];
  const http = new UpstreamClient({ fetch: f.fetch, now, timers: new ManualTimers(), onError: (url) => errors.push(url) });
  const repo = new ContentMetaRepo(openDb(":memory:"), now);
  const key = opts.key === undefined ? "cf-key" : opts.key;
  return { ...f, repo, errors, adapter: new CurseForgeAdapter(http, repo, () => key) };
}

describe("CurseForgeAdapter", () => {
  it("without a key it answers 409 and never fetches", async () => {
    const t = setup({ key: null });
    await expect(t.adapter.search(q({ kind: "mod" }))).rejects.toMatchObject({ status: 409, message: NO_KEY_MESSAGE });
    await expect(t.adapter.project("238222")).rejects.toMatchObject({ status: 409 });
    await expect(t.adapter.versionsByIds(["5101"])).rejects.toMatchObject({ status: 409 });
    expect(NO_KEY_MESSAGE).toBe("Save a CurseForge API key in Settings to browse CurseForge");
    expect(t.calls).toEqual([]);
  });

  it("searches with class, loader type and sort, key in the header only", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), fixture("search"));
    const r = await t.adapter.search({ kind: "mod", q: "jei", gameVersion: "1.21.1", loaders: ["neoforge"], category: null, sort: "newest", offset: 40 });
    expect(t.calls[0]!.url).toBe("https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&searchFilter=jei&gameVersion=1.21.1&modLoaderType=6&sortField=11&sortOrder=desc&index=40&pageSize=20");
    expect(t.calls[0]!.headers["x-api-key"]).toBe("cf-key");
    expect(t.calls.every((c) => !c.url.includes("cf-key"))).toBe(true);
    expect(r).toEqual({
      hits: [{
        platform: "curseforge", projectId: "238222", slug: "jei", name: "Just Enough Items (JEI)", author: "mezz", summary: "View items and recipes",
        iconUrl: proxied("https://media.forgecdn.net/avatars/thumbnails/29/69/64/64/635838945588716414.jpeg"), downloads: 300000000, categories: ["API and Library"],
      }],
      total: 10_000, offset: 40, limit: 20, stale: false,
    });
  });

  it("sends modLoaderType only with a game version, and the category when set", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), fixture("search"));
    await t.adapter.search(q({ kind: "mod", loaders: ["fabric"], category: "421", sort: "downloads" }));
    expect(t.calls[0]!.url).toBe(`${API}/mods/search?gameId=432&classId=6&categoryId=421&sortField=6&sortOrder=desc&index=0&pageSize=20`);
  });

  it("plugins use class 5 and no modLoaderType [F1]", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), fixture("search"));
    await t.adapter.search(q({ kind: "plugin", gameVersion: "1.21.1", loaders: ["paper", "spigot", "bukkit"], sort: "updated" }));
    expect(t.calls[0]!.url).toBe(`${API}/mods/search?gameId=432&classId=5&gameVersion=1.21.1&sortField=3&sortOrder=desc&index=0&pageSize=20`);
  });

  it("modpacks use class 4471", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), fixture("search"));
    await t.adapter.search(q({ kind: "modpack", gameVersion: "1.20.1", loaders: ["forge"] }));
    expect(t.calls[0]!.url).toBe(`${API}/mods/search?gameId=432&classId=4471&gameVersion=1.20.1&sortField=2&sortOrder=desc&index=0&pageSize=20`);
  });

  it("has no datapacks", async () => {
    const t = setup();
    await expect(t.adapter.search(q({ kind: "datapack" }))).rejects.toMatchObject({ status: 400 });
    expect(t.calls).toEqual([]);
  });

  it("maps a rejected key to a 502 with a hint", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), "forbidden", 403);
    await expect(t.adapter.search(q({}))).rejects.toMatchObject({ status: 502, message: "CurseForge rejected the API key: check it in Settings" });
    expect(CURSEFORGE_KEY_REJECTED).toBe("CurseForge rejected the API key: check it in Settings");
    expect(t.errors.every((u) => !u.includes("cf-key"))).toBe(true);
  });

  it("a 200 with another shape is a 502", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/search`), { data: "x" });
    await expect(t.adapter.search(q({}))).rejects.toMatchObject({ status: 502, message: "Could not query CurseForge" });
  });

  it("lists categories without the class entries", async () => {
    const t = setup();
    t.reply(`${API}/categories?gameId=432&classId=5`, fixture("categories"));
    expect(await t.adapter.categories("plugin")).toEqual([{ id: "421", label: "API and Library" }, { id: "412", label: "Technology" }]);
  });

  it("maps a project with its sanitised HTML description", async () => {
    const t = setup();
    t.reply(`${API}/mods/238222`, fixture("mod"));
    t.reply(`${API}/mods/238222/description`, fixture("description"));
    const p = await t.adapter.project("238222");
    expect(p).toMatchObject({
      platform: "curseforge", projectId: "238222", slug: "jei", author: "mezz", clientOnly: false, distributable: true,
      pageUrl: "https://www.curseforge.com/minecraft/mc-mods/jei",
      gallery: [proxied("https://media.forgecdn.net/attachments/1/2/shot.png")],
      links: [{ label: "Issues", url: "https://github.com/mezz/JustEnoughItems/issues" }],
    });
    expect(p.descriptionHtml).toBe(`<p>JEI <img src="${proxied("https://media.forgecdn.net/attachments/1/2/d.png")}" alt="d" /></p>`);
  });

  it("splits gameVersions into versions and loaders", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/238222/files`), fixture("files"));
    const r = await t.adapter.versions("238222", { kind: "mod", gameVersion: "1.21.1", loaders: ["neoforge"] });
    expect(t.calls[0]!.url).toBe(`${API}/mods/238222/files?gameVersion=1.21.1&modLoaderType=6&index=0&pageSize=50`);
    expect(r.versions.map((v) => [v.versionId, v.gameVersions, v.loaders, v.type, v.label])).toEqual([
      ["5102", ["1.21.1", "24w14a"], ["forge", "neoforge"], "beta", "jei-1.21.1-neoforge-19.1.0.0"],
      ["5101", ["1.21.1"], ["neoforge"], "release", "jei-1.21.1-neoforge-19.0.0.1"],
    ]);
    expect(r.versions[1]!.publishedAt).toBe("2024-08-01T10:00:00.120Z");
  });

  it("plugin files carry no modLoaderType [F1]", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/31054/files`), { data: [], pagination: { index: 0, pageSize: 50, resultCount: 0, totalCount: 0 } });
    await t.adapter.versions("31054", { kind: "plugin", gameVersion: "1.21.1", loaders: ["paper"] });
    expect(t.calls[0]!.url).toBe(`${API}/mods/31054/files?gameVersion=1.21.1&index=0&pageSize=50`);
  });

  it("maps relation types and drops tools and includes", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/238222/files`), fixture("files"));
    const r = await t.adapter.versions("238222", { kind: "mod", gameVersion: null, loaders: [] });
    expect(r.versions[1]!.dependencies).toEqual([
      { projectId: "1001", versionId: null, type: "required" },
      { projectId: "1002", versionId: null, type: "optional" },
      { projectId: "1003", versionId: null, type: "incompatible" },
      { projectId: "1004", versionId: null, type: "embedded" },
    ]);
  });

  it("marks files without third-party distribution as not installable", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/mods/238222/files`), fixture("files"));
    const r = await t.adapter.versions("238222", { kind: "mod", gameVersion: null, loaders: [] });
    expect(r.versions[0]).toMatchObject({ versionId: "5102", installable: false, reason: NOT_DISTRIBUTABLE });
    expect(r.versions[1]).toMatchObject({ versionId: "5101", installable: true, reason: null });
    expect(NOT_DISTRIBUTABLE).toBe("The author does not allow third-party downloads: the server cannot install it");
  });

  it("batches projects and files by POST with the key header", async () => {
    const t = setup();
    t.reply(`${API}/mods`, { data: [(fixture("mod") as { data: object }).data] });
    t.reply(`${API}/mods/files`, fixture("files"));
    expect(await t.adapter.projects(["238222", "abc"])).toEqual([{
      projectId: "238222", slug: "jei", name: "Just Enough Items (JEI)", author: "mezz",
      iconUrl: proxied("https://media.forgecdn.net/avatars/thumbnails/29/69/64/64/a.jpeg"), clientOnly: false, distributable: true,
    }]);
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ modIds: [238222], filterPcOnly: true });
    expect((await t.adapter.versionsByIds(["5101", "5102"])).map((v) => v.versionId)).toEqual(["5101", "5102"]);
    expect(JSON.parse(t.calls[1]!.body!)).toEqual({ fileIds: [5101, 5102] });
    expect(t.calls.map((c) => [c.method, c.headers["x-api-key"]])).toEqual([["POST", "cf-key"], ["POST", "cf-key"]]);
    expect(t.repo.get("curseforge", "version", "5101")).not.toBeNull();
    expect(t.repo.get("curseforge", "project", "238222")).not.toBeNull();
  });

  it("resolves a slug through search by slug and class", async () => {
    const t = setup();
    t.reply(`${API}/mods/search?gameId=432&classId=5&slug=worldguard`, { data: [{ ...(fixture("mod") as { data: object }).data, id: 31054, slug: "worldguard" }], pagination: { index: 0, pageSize: 50, resultCount: 1, totalCount: 1 } });
    const e = { raw: "worldguard:5719698", projectRef: "worldguard", versionRef: "5719698", pinned: false };
    expect(await t.adapter.resolveRefs([e, e], "plugin")).toEqual([{ projectId: "31054", versionId: "5719698" }, { projectId: "31054", versionId: "5719698" }]);
    expect(t.calls).toHaveLength(1);
    expect(await t.adapter.resolveRefs([{ raw: "31054", projectRef: "31054", versionRef: null, pinned: false }, e], "plugin"))
      .toEqual([{ projectId: "31054", versionId: null }, { projectId: "31054", versionId: "5719698" }]);
    expect(t.calls).toHaveLength(1);
  });

  it("an unknown slug is null; a slug the source could not be asked about is unavailable", async () => {
    const t = setup();
    t.reply(`${API}/mods/search?gameId=432&classId=6&slug=nope`, { data: [{ ...(fixture("mod") as { data: object }).data, slug: "nope-2" }], pagination: { index: 0, pageSize: 50, resultCount: 1, totalCount: 1 } });
    expect(await t.adapter.resolveRefs([{ raw: "nope", projectRef: "nope", versionRef: null, pinned: false }, { raw: "down", projectRef: "down", versionRef: null, pinned: false }], "mod"))
      .toEqual([null, REF_UNAVAILABLE]);
  });

  it("reads a pack manifest from the file's download url", async () => {
    const t = setup();
    t.reply(`${API}/mods/715572/files/5500000`, fixture("pack-file"));
    t.reply(`${API}/mods/715572`, fixture("pack-mod"));
    const manifest = {
      minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.3.0", primary: true }] },
      files: [{ projectID: 238222, fileID: 5101, required: true }, { projectID: 1001, fileID: 1, required: true }, { projectID: 238222, fileID: 5102, required: true }],
    };
    t.reply("https://edge.forgecdn.net/files/5500/0/atm9.zip", zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)) }));
    const p = await t.adapter.pack("715572", "5500000");
    expect(p).toEqual({
      platform: "curseforge", projectId: "715572", slug: "all-the-mods-9", versionId: "5500000", name: "All the Mods 9",
      versionLabel: "All the Mods 9-0.3.0", iconUrl: proxied("https://media.forgecdn.net/avatars/thumbnails/1/2/atm.png"),
      minecraftVersion: "1.20.1", loader: "forge", loaderVersion: "47.3.0",
      contents: [{ platform: "curseforge", projectId: "238222" }, { platform: "curseforge", projectId: "1001" }],
      contentsKnown: true, reason: null,
    });
    const download = t.calls.find((c) => c.url.startsWith("https://edge.forgecdn.net"))!;
    expect(download.headers["x-api-key"]).toBeUndefined();
  });

  it("a pack without a download url has unknown contents", async () => {
    const t = setup();
    t.reply(`${API}/mods/715572/files/5500000`, { data: { ...(fixture("pack-file") as { data: object }).data, downloadUrl: null } });
    t.reply(`${API}/mods/715572`, fixture("pack-mod"));
    expect(await t.adapter.pack("715572", "5500000")).toMatchObject({
      contentsKnown: false, reason: NOT_DISTRIBUTABLE, contents: [], minecraftVersion: "1.20.1", loader: "forge", loaderVersion: null,
    });
    expect(t.calls).toHaveLength(2);
  });

  describe("latestFor", () => {
    const cur = (projectId: string, versionId: string, type: "release" | "beta" | "alpha") => ({
      platform: "curseforge" as const, projectId, versionId, label: versionId, type, publishedAt: "2024-01-01T00:00:00.000Z",
      gameVersions: ["1.21.1"], loaders: ["neoforge"], dependencies: [], installable: true, reason: null,
    });
    const idx = (fileId: number, releaseType: 1 | 2 | 3, modLoader: number | null, gameVersion = "1.21.1") =>
      ({ gameVersion, fileId, filename: `f${fileId}.jar`, releaseType, gameVersionTypeId: 1, modLoader });
    const mod = (id: number, indexes: object[]) => ({ ...(fixture("mod") as { data: object }).data, id, latestFilesIndexes: indexes });
    const file = (id: number, modId: number, releaseType = 1) => ({
      id, modId, displayName: `file ${id}`, releaseType, fileDate: `2024-0${(id % 9) + 1}-01T00:00:00Z`, downloadUrl: "https://edge.forgecdn.net/x",
      gameVersions: ["1.21.1", "NeoForge"], dependencies: [],
    });

    it("picks from latestFilesIndexes by game version, loader and channel, then reads the chosen files in one batch", async () => {
      const t = setup();
      t.reply(`${API}/mods`, { data: [
        mod(100, [idx(7, 1, 6), idx(9, 2, 6), idx(8, 1, 1), idx(12, 1, 6, "1.20.1"), idx(6, 1, 6)]),
        mod(200, [idx(30, 3, 6), idx(20, 1, 0)]),
        mod(300, [idx(40, 1, 1)]),
      ] });
      t.reply(`${API}/mods/files`, { data: [file(7, 100), file(9, 100, 2), file(20, 200)] });
      const r = await t.adapter.latestFor(
        [cur("100", "5", "release"), cur("100", "4", "beta"), cur("200", "15", "release"), cur("300", "35", "release"), cur("400", "45", "release")],
        { kind: "mod", gameVersion: "1.21.1", loaders: ["neoforge"] },
      );
      expect(JSON.parse(t.calls[0]!.body!)).toEqual({ modIds: [100, 200, 300, 400], filterPcOnly: true });
      expect(JSON.parse(t.calls[1]!.body!)).toEqual({ fileIds: [7, 9, 20] });
      expect(t.calls.every((c) => c.headers["x-api-key"] === "cf-key")).toBe(true);
      expect(r.get("5")?.versionId).toBe("7"); // release only: 7 (9 is a beta, 8 is Forge, 12 another version)
      expect(r.get("4")?.versionId).toBe("9"); // a beta may move to a newer beta
      expect(r.get("15")?.versionId).toBe("20"); // modLoader 0 = any
      expect(r.get("35")).toBeNull(); // only a Forge file
      expect(r.has("45")).toBe(false); // mod 400 not returned: not checked
    });

    it("plugins ignore the loader [F1]; a failing batch is not checked", async () => {
      const t = setup();
      t.reply(`${API}/mods`, { data: [mod(31054, [idx(5719698, 1, null)])] });
      t.reply(`${API}/mods/files`, { data: [file(5719698, 31054)] });
      const r = await t.adapter.latestFor([cur("31054", "5000000", "release")], { kind: "plugin", gameVersion: "1.21.1", loaders: ["paper"] });
      expect(r.get("5000000")?.versionId).toBe("5719698");
      const t2 = setup();
      expect((await t2.adapter.latestFor([cur("31054", "5000000", "release")], { kind: "plugin", gameVersion: "1.21.1", loaders: [] })).size).toBe(0);
    });
  });
});
