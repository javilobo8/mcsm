import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ContentVersionDto } from "@mcsm/shared";
import { browserReducer, defaultVersionId, formatDownloads, hitStatus, initialBrowserState, installedRefs, kindLabel, packContents, platformLabel, searchQuery, type BrowserState } from "./content-browser";

const initial = initialBrowserState({ platform: "modrinth", kind: "mod" });
const sodium = { projectId: "AANobbMI", versionId: "", name: "Sodium", slug: "sodium", list: "mods.modrinthProjects" as const };
const lithium = { projectId: "gvQqBUqZ", versionId: "", name: "Lithium", slug: "lithium", list: "mods.modrinthProjects" as const };

const browsing = (): BrowserState => {
  let s = browserReducer(initial, { type: "toggle", item: sodium });
  s = browserReducer(s, { type: "page", offset: 40 });
  return browserReducer(s, { type: "open", projectId: "AANobbMI" });
};

const ver = (versionId: string, type: ContentVersionDto["type"], publishedAt: string, installable = true): ContentVersionDto => ({
  platform: "modrinth", projectId: "AANobbMI", versionId, label: versionId, type, publishedAt, gameVersions: ["1.21.1"], loaders: ["fabric"],
  dependencies: [], installable, reason: installable ? null : "Not distributable",
});

describe("browserReducer", () => {
  it("starts on the tab with nothing selected", () => {
    expect(initial).toMatchObject({ tab: { platform: "modrinth", kind: "mod" }, q: "", category: null, sort: "relevance", offset: 0, detail: null, anyVersion: false });
    expect(initial.selected.size).toBe(0);
  });
  it("changing tab clears the selection and the page", () => {
    const s = browserReducer({ ...browsing(), category: "optimization" }, { type: "tab", tab: { platform: "curseforge", kind: "mod" } });
    expect(s).toMatchObject({ tab: { platform: "curseforge", kind: "mod" }, offset: 0, detail: null, category: null });
    expect(s.selected.size).toBe(0);
  });
  it("changing the query keeps the selection but resets offset and detail", () => {
    const s = browserReducer(browsing(), { type: "query", q: "lith" });
    expect(s).toMatchObject({ q: "lith", offset: 0, detail: null });
    expect([...s.selected.keys()]).toEqual(["AANobbMI"]);
  });
  it("category, sort and any version also reset the page", () => {
    expect(browserReducer(browsing(), { type: "category", category: "storage" })).toMatchObject({ category: "storage", offset: 0, detail: null });
    expect(browserReducer(browsing(), { type: "sort", sort: "downloads" })).toMatchObject({ sort: "downloads", offset: 0, detail: null });
    expect(browserReducer(browsing(), { type: "anyVersion", on: true })).toMatchObject({ anyVersion: true, offset: 0, detail: null });
  });
  it("toggling twice unselects", () => {
    const once = browserReducer(initial, { type: "toggle", item: sodium });
    const twice = browserReducer(once, { type: "toggle", item: sodium });
    expect([...once.selected.keys()]).toEqual(["AANobbMI"]);
    expect(twice.selected.size).toBe(0);
    expect(initial.selected.size).toBe(0); // never mutated
  });
  it("several projects can be selected, but only one modpack", () => {
    const mods = browserReducer(browserReducer(initial, { type: "toggle", item: sodium }), { type: "toggle", item: lithium });
    expect(mods.selected.size).toBe(2);
    const packs = initialBrowserState({ platform: "modrinth", kind: "modpack" });
    const a = { ...sodium, list: null };
    const b = { ...lithium, list: null };
    const one = browserReducer(browserReducer(packs, { type: "toggle", item: a }), { type: "toggle", item: b });
    expect([...one.selected.keys()]).toEqual(["gvQqBUqZ"]);
  });
  it("version changes the chosen version of a selected project only", () => {
    const s = browserReducer(browserReducer(initial, { type: "toggle", item: sodium }), { type: "version", projectId: "AANobbMI", versionId: "Yp8wLY1P" });
    expect(s.selected.get("AANobbMI")?.versionId).toBe("Yp8wLY1P");
    expect(browserReducer(initial, { type: "version", projectId: "AANobbMI", versionId: "x" })).toBe(initial);
  });
  it("clear empties the selection", () => {
    expect(browserReducer(browsing(), { type: "clear" }).selected.size).toBe(0);
  });
});

describe("searchQuery", () => {
  it("searchQuery is null while the target is not ready", () => expect(searchQuery(initial, null)).toBeNull());
  it("searchQuery passes kind, loaders and version", () =>
    expect(searchQuery(initial, { gameVersion: "1.21.1", loaders: ["fabric"] })).toEqual({ kind: "mod", q: "", gameVersion: "1.21.1", loaders: ["fabric"], sort: "relevance", offset: 0 }));
  it("passes the trimmed query, the category and the page", () => {
    const s = { ...initial, q: "  sodium ", category: "optimization", sort: "downloads" as const, offset: 20 };
    expect(searchQuery(s, { gameVersion: "1.21.1", loaders: [] })).toEqual({ kind: "mod", q: "sodium", gameVersion: "1.21.1", loaders: [], category: "optimization", sort: "downloads", offset: 20 });
  });
  it("modpacks with anyVersion search without a game version", () => {
    const packs = initialBrowserState({ platform: "modrinth", kind: "modpack" });
    expect(searchQuery({ ...packs, anyVersion: true }, { gameVersion: "1.21.1", loaders: [] })).toEqual({ kind: "modpack", q: "", loaders: [], sort: "relevance", offset: 0 });
    expect(searchQuery(packs, { gameVersion: "1.21.1", loaders: [] })).toMatchObject({ gameVersion: "1.21.1" });
    expect(searchQuery(packs, { gameVersion: "", loaders: [] })).not.toHaveProperty("gameVersion");
  });
  it("an initial state can start with any version on (new server)", () => {
    expect(initialBrowserState({ platform: "curseforge", kind: "modpack" }, { anyVersion: true }).anyVersion).toBe(true);
  });
});

describe("defaultVersionId", () => {
  it("defaultVersionId skips non-installable versions and prefers releases", () => {
    const versions = [ver("beta2", "beta", "2026-10-03"), ver("rel3", "release", "2026-10-02", false), ver("rel2", "release", "2026-10-01"), ver("rel1", "release", "2026-09-01")];
    expect(defaultVersionId(versions, null)).toBe("rel2");
    expect(defaultVersionId([ver("beta2", "beta", "2026-10-03"), ver("a", "alpha", "2026-10-04")], null)).toBe("beta2");
  });
  it("keeps the current choice while it is installable", () => {
    const versions = [ver("rel2", "release", "2026-10-01"), ver("rel1", "release", "2026-09-01"), ver("bad", "release", "2026-08-01", false)];
    expect(defaultVersionId(versions, "rel1")).toBe("rel1");
    expect(defaultVersionId(versions, "bad")).toBe("rel2");
    expect(defaultVersionId([], null)).toBeNull();
  });
});

describe("installed badges", () => {
  const spec = {
    ...defaultSpecInput(), type: "MODRINTH", version: "LATEST",
    modpack: { platform: "MODRINTH" as const, slugOrUrl: "P0000001", versionId: "V0000001", loader: "fabric" as const },
    mods: { modrinthProjects: ["AANobbMI:Yp8wLY1P", "lithium"], curseforgeFiles: ["238222:5101366"], urls: [] },
  };
  it("collects the project refs present on a platform, the pack included", () => {
    expect(installedRefs(spec, "modrinth")).toEqual(new Set(["AANobbMI", "lithium", "P0000001"]));
    expect(installedRefs(spec, "curseforge")).toEqual(new Set(["238222"]));
  });
  it("a hit is installed by id or slug, or in the modpack", () => {
    const installed = installedRefs(spec, "modrinth");
    const inPack = new Set(["P7dR8mSH"]);
    expect(hitStatus({ projectId: "AANobbMI", slug: "sodium" }, installed, inPack)).toBe("installed");
    expect(hitStatus({ projectId: "gvQqBUqZ", slug: "lithium" }, installed, inPack)).toBe("installed");
    expect(hitStatus({ projectId: "P7dR8mSH", slug: "fabric-api" }, installed, inPack)).toBe("in-modpack");
    expect(hitStatus({ projectId: "ZZZZZZZZ", slug: "chunky" }, installed, inPack)).toBeNull();
  });
  it("pack contents of the pack's platform only", () => {
    const pack = { platform: "modrinth" as const, contents: [{ platform: "modrinth" as const, projectId: "A" }, { platform: "curseforge" as const, projectId: "1" }] };
    expect(packContents(pack, "modrinth")).toEqual(new Set(["A"]));
    expect(packContents(pack, "curseforge")).toEqual(new Set(["1"]));
    expect(packContents(null, "modrinth")).toEqual(new Set());
  });
});

describe("labels", () => {
  it("names tabs and formats downloads compactly", () => {
    expect(kindLabel("datapack")).toBe("Datapacks");
    expect(platformLabel("curseforge")).toBe("CurseForge");
    expect(formatDownloads(98_400_000)).toBe("98M");
    expect(formatDownloads(1234)).toBe("1.2K");
  });
});
