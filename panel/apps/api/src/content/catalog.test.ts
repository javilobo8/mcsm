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
    t.replyWhen(isPath(`${API}/projects`), [project("P7dR8mSH", "fabric-api", "Fabric API")]); // "nope" is unknown
    t.replyWhen(isPath(`${API}/teams`), []);
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

  it("resolves 250 raw slugs with a handful of requests", async () => {
    const t = setup();
    t.replyWhen(isPath(`${API}/projects`), (u: URL) => (JSON.parse(u.searchParams.get("ids")!) as string[])
      .map((slug) => project(`P${slug.replace(/\D/g, "").padStart(7, "0")}`, slug, slug)));
    t.replyWhen(isPath(`${API}/teams`), []);
    const entries = Array.from({ length: 250 }, (_, i) => ({ list: "mods.modrinthProjects" as const, entry: `mod-${i}` }));
    const r = await t.catalog.lookup(entries);
    expect(r.every((e) => e.resolved)).toBe(true);
    expect(r[249]).toMatchObject({ projectId: "P0000249", name: "mod-249" });
    expect(t.calls.length).toBeLessThanOrEqual(6); // 3 × /projects + 3 × /teams
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
  const UPDATE = `${API}/version_files/update`;
  const target = { gameVersion: "1.21.1", loaders: ["fabric" as const] };
  /** Current version in the repo with its primary file's sha1. */
  const installed = (t: ReturnType<typeof setup>, v: ContentVersionDto, sha1: string) => {
    t.repo.put("modrinth", "version", v.versionId, v);
    t.repo.put("modrinth", "file", v.versionId, sha1);
    t.repo.put("modrinth", "project", v.projectId, meta(v.projectId, v.projectId));
  };

  it("a release entry whose newest compatible release is itself has no update", async () => {
    const t = setup();
    const current = ver("AANobbMI", "relVer02", { publishedAt: "2024-02-01T00:00:00.000Z" });
    installed(t, current, "a".repeat(40));
    t.reply(UPDATE, { ["a".repeat(40)]: wire(current) });
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target, entries: ["AANobbMI:relVer02"] });
    expect(r).toEqual([{ entry: "AANobbMI:relVer02", projectId: "AANobbMI", currentVersionId: "relVer02", compatible: true, checked: true, latest: null }]);
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ hashes: ["a".repeat(40)], algorithm: "sha1", loaders: ["fabric"], game_versions: ["1.21.1"], version_types: ["release"] });
  });

  it("offers the newer version the batch returns", async () => {
    const t = setup();
    installed(t, ver("AANobbMI", "relVer02", { publishedAt: "2024-02-01T00:00:00.000Z" }), "a".repeat(40));
    t.reply(UPDATE, { ["a".repeat(40)]: wire(ver("AANobbMI", "relVer05", { label: "0.7.0", publishedAt: "2024-05-01T00:00:00.000Z" })) });
    const [u] = await t.catalog.updates({ list: "mods.modrinthProjects", target, entries: ["AANobbMI:relVer02"] });
    expect(u).toMatchObject({ compatible: true, checked: true, latest: { versionId: "relVer05", label: "0.7.0", type: "release", entry: "AANobbMI:relVer05" } });
  });

  it("an entry that does not fit a new target is flagged and offered the newest compatible release", async () => {
    const t = setup();
    installed(t, ver("AANobbMI", "relVer02", { publishedAt: "2024-09-01T00:00:00.000Z" }), "a".repeat(40));
    t.reply(UPDATE, { ["a".repeat(40)]: wire(ver("AANobbMI", "relVer04", { gameVersions: ["1.21.4"], publishedAt: "2024-04-01T00:00:00.000Z" })) });
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.4", loaders: ["fabric"] }, entries: ["AANobbMI:relVer02"] });
    expect(r).toEqual([{
      entry: "AANobbMI:relVer02", projectId: "AANobbMI", currentVersionId: "relVer02", compatible: false, checked: true,
      latest: { versionId: "relVer04", label: "relVer04", type: "release", entry: "AANobbMI:relVer04" },
    }]);
  });

  it("checks 300 entries with a handful of requests", async () => {
    const t = setup();
    const ids = Array.from({ length: 300 }, (_, i) => `P${String(i).padStart(7, "0")}`);
    ids.forEach((pid, i) => installed(t, ver(pid, `V${String(i).padStart(7, "0")}`), i.toString(16).padStart(40, "0")));
    t.replyWhen(isPath(UPDATE), {});
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target, entries: ids.map((pid, i) => `${pid}:V${String(i).padStart(7, "0")}`) });
    expect(r.every((u) => u.checked && u.latest === null)).toBe(true);
    expect(t.calls).toHaveLength(3); // 300 hashes, 100 per request
  });

  it("a failed check is reported as not checked, never as up to date", async () => {
    const t = setup();
    installed(t, ver("AANobbMI", "relVer02"), "a".repeat(40));
    t.reply(UPDATE, "slow down", 429);
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target, entries: ["AANobbMI:relVer02", "AANobbMI:missing1"] });
    expect(r).toEqual([
      { entry: "AANobbMI:relVer02", projectId: "AANobbMI", currentVersionId: "relVer02", compatible: true, checked: false, latest: null },
      { entry: "AANobbMI:missing1", projectId: null, currentVersionId: null, compatible: true, checked: false, latest: null },
    ]);
  });

  it("an unpinned entry follows the newest version by itself: nothing to check", async () => {
    const t = setup();
    t.repo.put("modrinth", "ref", "sodium", "AANobbMI");
    t.repo.put("modrinth", "project", "AANobbMI", meta("AANobbMI", "Sodium"));
    const r = await t.catalog.updates({ list: "mods.modrinthProjects", target, entries: ["sodium"] });
    expect(r).toEqual([{ entry: "sodium", projectId: "AANobbMI", currentVersionId: null, compatible: true, checked: true, latest: null }]);
    expect(t.calls).toEqual([]);
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
