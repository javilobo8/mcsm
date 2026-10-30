import type { ContentVersionDto } from "@mcsm/shared";
import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { openDb } from "../db/db.js";
import type { ProjectMeta } from "./adapter.js";
import { ContentCatalog, META_MAX_AGE_MS } from "./catalog.js";
import { ContentMetaRepo } from "./repo.js";

const API = "https://api.modrinth.com/v2";
const isPath = (p: string) => (u: URL) => u.origin + u.pathname === p;

function setup(opts: { key?: string | null } = {}) {
  let now = Date.parse("2026-10-30T10:00:00Z");
  const f = fakeContentFetch();
  const repo = new ContentMetaRepo(openDb(":memory:"), () => now);
  const catalog = new ContentCatalog({
    repo, curseforgeKey: () => (opts.key === undefined ? "cf-key" : opts.key), fetch: f.fetch, now: () => now, timers: new ManualTimers(),
  });
  return { ...f, repo, catalog, advance: (ms: number) => { now += ms; } };
}

const meta = (projectId: string, name: string): ProjectMeta => ({
  projectId, slug: name.toLowerCase(), name, author: "someone", iconUrl: null, clientOnly: false, distributable: true,
});
const ver = (projectId: string, versionId: string, over: Partial<ContentVersionDto> = {}): ContentVersionDto => ({
  platform: "modrinth", projectId, versionId, label: versionId, type: "release", publishedAt: "2024-01-01T00:00:00.000Z",
  gameVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [], installable: true, reason: null, ...over,
});
/** Modrinth's wire format for a version (what the adapter reads). */
const wire = (v: ContentVersionDto) => ({
  id: v.versionId, project_id: v.projectId, version_number: v.label, version_type: v.type, date_published: v.publishedAt,
  game_versions: v.gameVersions, loaders: v.loaders, dependencies: [], files: [],
});
const project = (id: string, slug: string, title: string) => ({ id, slug, title, team: "TeamTeam", downloads: 1, project_type: "mod" });

describe("ContentCatalog.lookup", () => {
  it("serves pinned entries from the repo, resolves a raw slug once and marks unknown entries", async () => {
    const t = setup();
    t.repo.put("modrinth", "version", "SodVer01", ver("AANobbMI", "SodVer01", { label: "0.6.0", dependencies: [{ projectId: "P7dR8mSH", versionId: null, type: "required" }] }));
    t.repo.put("modrinth", "project", "AANobbMI", meta("AANobbMI", "Sodium"));
    t.reply(`${API}/project/fabric-api`, project("P7dR8mSH", "fabric-api", "Fabric API"));
    t.replyWhen(isPath(`${API}/projects`), [project("P7dR8mSH", "fabric-api", "Fabric API")]);
    t.replyWhen(isPath(`${API}/teams`), []);
    t.reply(`${API}/project/nope`, "", 404);
    const entries = [
      { list: "mods.modrinthProjects" as const, entry: "AANobbMI:SodVer01" },
      { list: "mods.modrinthProjects" as const, entry: "fabric-api" },
      { list: "mods.modrinthProjects" as const, entry: "nope" },
    ];
    const r = await t.catalog.lookup(entries);
    expect(r[0]).toEqual({
      list: "mods.modrinthProjects", raw: "AANobbMI:SodVer01", resolved: true, projectId: "AANobbMI", versionId: "SodVer01",
      slug: "sodium", name: "Sodium", author: "someone", iconUrl: null, versionLabel: "0.6.0", versionType: "release",
      gameVersions: ["1.21.1"], loaders: ["fabric"], dependencies: [{ projectId: "P7dR8mSH", versionId: null, type: "required" }],
    });
    expect(r[1]).toMatchObject({ raw: "fabric-api", resolved: true, projectId: "P7dR8mSH", versionId: null, name: "Fabric API", versionLabel: null });
    expect(r[2]).toEqual({
      list: "mods.modrinthProjects", raw: "nope", resolved: false, projectId: null, versionId: null, slug: null, name: null, author: null,
      iconUrl: null, versionLabel: null, versionType: null, gameVersions: [], loaders: [], dependencies: [],
    });
    expect(t.calls.every((c) => !c.url.includes("SodVer01") && !c.url.includes("AANobbMI"))).toBe(true);

    const n = t.calls.length;
    const again = await t.catalog.lookup(entries.slice(0, 2));
    expect(again.map((e) => e.resolved)).toEqual([true, true]);
    expect(t.calls).toHaveLength(n);
  });

  it("with every source failing, what the repo holds still comes back resolved", async () => {
    const t = setup();
    t.repo.put("modrinth", "version", "SodVer01", ver("AANobbMI", "SodVer01"));
    t.repo.put("modrinth", "project", "AANobbMI", meta("AANobbMI", "Sodium"));
    t.repo.put("curseforge", "version", "5101", { ...ver("238222", "5101"), platform: "curseforge" });
    t.repo.put("curseforge", "project", "238222", meta("238222", "JEI"));
    const r = await t.catalog.lookup([
      { list: "mods.modrinthProjects", entry: "AANobbMI:SodVer01" },
      { list: "mods.modrinthProjects", entry: "AANobbMI:OtherVer" },
      { list: "mods.curseforgeFiles", entry: "238222:5101" },
      { list: "mods.curseforgeFiles", entry: "jei" },
    ]);
    expect(r.map((e) => [e.raw, e.resolved, e.name])).toEqual([
      ["AANobbMI:SodVer01", true, "Sodium"], ["AANobbMI:OtherVer", false, null], ["238222:5101", true, "JEI"], ["jei", false, null],
    ]);
  });

  it("without a CurseForge key it still answers from the repo, without touching the network", async () => {
    const t = setup({ key: null });
    t.repo.put("curseforge", "version", "5101", { ...ver("238222", "5101"), platform: "curseforge" });
    t.repo.put("curseforge", "project", "238222", meta("238222", "JEI"));
    const r = await t.catalog.lookup([{ list: "mods.curseforgeFiles", entry: "238222:5101" }, { list: "mods.curseforgeFiles", entry: "1:2" }]);
    expect(r.map((e) => e.resolved)).toEqual([true, false]);
    expect(t.calls).toEqual([]);
  });
});

describe("ContentCatalog.updates", () => {
  const versionsUrl = isPath(`${API}/project/AANobbMI/version`);

  it("a release entry with a newer beta and an older release has no update", async () => {
    const t = setup();
    const current = ver("AANobbMI", "relVer02", { publishedAt: "2024-02-01T00:00:00.000Z" });
    t.repo.put("modrinth", "version", "relVer02", current);
    t.repo.put("modrinth", "project", "AANobbMI", meta("AANobbMI", "Sodium"));
    t.replyWhen(versionsUrl, [
      wire(ver("AANobbMI", "betVer03", { type: "beta", publishedAt: "2024-03-01T00:00:00.000Z" })),
      wire(current),
      wire(ver("AANobbMI", "relVer01", { publishedAt: "2024-01-01T00:00:00.000Z" })),
    ]);
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: ["fabric"] }, entries: ["AANobbMI:relVer02"] });
    expect(r).toEqual([{ entry: "AANobbMI:relVer02", projectId: "AANobbMI", currentVersionId: "relVer02", compatible: true, latest: null }]);
    const u = new URL(t.calls[0]!.url);
    expect(JSON.parse(u.searchParams.get("game_versions")!)).toEqual(["1.21.1"]);
    expect(JSON.parse(u.searchParams.get("loaders")!)).toEqual(["fabric"]);
  });

  it("an entry that does not fit a new target is flagged and offered the newest compatible release", async () => {
    const t = setup();
    t.repo.put("modrinth", "version", "relVer02", ver("AANobbMI", "relVer02"));
    t.repo.put("modrinth", "project", "AANobbMI", meta("AANobbMI", "Sodium"));
    t.replyWhen(versionsUrl, [
      wire(ver("AANobbMI", "betVer05", { type: "beta", gameVersions: ["1.21.4"], publishedAt: "2024-05-01T00:00:00.000Z" })),
      wire(ver("AANobbMI", "relVer04", { gameVersions: ["1.21.4"], publishedAt: "2024-04-01T00:00:00.000Z" })),
      wire(ver("AANobbMI", "relVer03", { gameVersions: ["1.21.4"], publishedAt: "2024-03-01T00:00:00.000Z" })),
      wire(ver("AANobbMI", "relVer09", { gameVersions: ["1.21.1"], publishedAt: "2024-09-01T00:00:00.000Z" })),
    ]);
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.4", loaders: ["fabric"] }, entries: ["AANobbMI:relVer02"] });
    expect(r).toEqual([{
      entry: "AANobbMI:relVer02", projectId: "AANobbMI", currentVersionId: "relVer02", compatible: false,
      latest: { versionId: "relVer04", label: "relVer04", type: "release", entry: "AANobbMI:relVer04" },
    }]);
  });

  it("an unresolved entry has no update and is not flagged", async () => {
    const t = setup();
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: [] }, entries: ["AANobbMI:missing1"] });
    expect(r).toEqual([{ entry: "AANobbMI:missing1", projectId: null, currentVersionId: null, compatible: true, latest: null }]);
  });
});

describe("ContentCatalog.resolve", () => {
  it("uses the installed entries and the pack of the same platform", async () => {
    const t = setup();
    t.repo.put("modrinth", "version", "AlphVer1", ver("AAAAAAAA", "AlphVer1", { dependencies: [
      { projectId: "BBBBBBBB", versionId: null, type: "required" },
      { projectId: "CCCCCCCC", versionId: null, type: "required" },
      { projectId: "DDDDDDDD", versionId: null, type: "required" },
    ] }));
    t.repo.put("modrinth", "version", "BetaVer1", ver("BBBBBBBB", "BetaVer1"));
    t.repo.put("modrinth", "project", "AAAAAAAA", meta("AAAAAAAA", "Alpha"));
    t.repo.put("modrinth", "project", "BBBBBBBB", meta("BBBBBBBB", "Beta"));
    t.repo.put("modrinth", "project", "CCCCCCCC", meta("CCCCCCCC", "Gamma"));
    t.repo.put("modrinth", "project", "DDDDDDDD", meta("DDDDDDDD", "Delta"));
    t.repo.put("modrinth", "pack", "PackVer1", {
      platform: "modrinth", projectId: "PPPPPPPP", slug: "p", versionId: "PackVer1", name: "P", versionLabel: "1", iconUrl: null,
      minecraftVersion: "1.21.1", loader: "fabric", loaderVersion: null, contents: [{ platform: "modrinth", projectId: "CCCCCCCC" }],
      contentsKnown: true, reason: null,
    });
    t.replyWhen(isPath(`${API}/project/DDDDDDDD/version`), [wire(ver("DDDDDDDD", "DeltVer1"))]);
    const r = await t.catalog.resolve({
      list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: ["fabric"] },
      selections: [{ projectId: "AAAAAAAA", versionId: "AlphVer1" }],
      present: [{ list: "datapacks.modrinthProjects", entry: "BBBBBBBB:BetaVer1" }],
      pack: { platform: "modrinth", projectId: "PPPPPPPP", versionId: "PackVer1" },
    });
    expect(r.add.map((e) => [e.entry, e.selected, e.requiredBy])).toEqual([["AAAAAAAA:AlphVer1", true, []], ["DDDDDDDD:DeltVer1", false, ["Alpha"]]]);
    expect(r.inPack).toEqual([{ projectId: "CCCCCCCC", name: "Gamma" }]);
  });

  it("CurseForge without a key answers 409", async () => {
    const t = setup({ key: null });
    await expect(t.catalog.resolve({
      list: "mods.curseforgeFiles", target: { gameVersion: "1.21.1", loaders: [] }, selections: [{ projectId: "1", versionId: "2" }], present: [], pack: null,
    })).rejects.toMatchObject({ status: 409 });
    expect(t.calls).toEqual([]);
  });
});

describe("ContentCatalog.purge", () => {
  it("deletes metadata older than 90 days", () => {
    const t = setup();
    t.repo.put("modrinth", "project", "old", 1);
    t.advance(META_MAX_AGE_MS + 1);
    t.repo.put("modrinth", "project", "new", 1);
    expect(t.catalog.purge()).toBe(1);
    expect(t.repo.get("modrinth", "project", "new")).not.toBeNull();
  });
});
