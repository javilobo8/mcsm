import { describe, expect, it } from "vitest";
import {
  contentSearchQuerySchema, curseforgeLoaderFor, formatContentEntry, modrinthLoadersFor, parseContentEntry, pickLatest, resolveRequestSchema,
  type ContentKind,
} from "./content.js";

describe("content entries", () => {
  it("parses pinned Modrinth and CurseForge entries", () => {
    expect(parseContentEntry("modrinth", "AANobbMI:Yp8wLY1P")).toEqual({ raw: "AANobbMI:Yp8wLY1P", projectRef: "AANobbMI", versionRef: "Yp8wLY1P", pinned: true });
    expect(parseContentEntry("curseforge", "238222:5846880")).toMatchObject({ projectRef: "238222", versionRef: "5846880", pinned: true });
  });
  it("keeps hand-typed entries raw", () => {
    expect(parseContentEntry("modrinth", "lithium:beta")).toMatchObject({ projectRef: "lithium", versionRef: "beta", pinned: false });
    expect(parseContentEntry("modrinth", "datapack:terralith")).toMatchObject({ projectRef: "terralith", versionRef: null, pinned: false });
    expect(parseContentEntry("modrinth", "pl3xmap?")).toMatchObject({ projectRef: "pl3xmap", pinned: false });
    expect(parseContentEntry("curseforge", "jei")).toMatchObject({ projectRef: "jei", versionRef: null, pinned: false });
  });
  it("formats an entry", () => expect(formatContentEntry("modrinth", "AANobbMI", "Yp8wLY1P")).toBe("AANobbMI:Yp8wLY1P"));
});
describe("targets", () => {
  it.each([
    ["QUILT", "mod", null, ["quilt", "fabric"]], ["PURPUR", "plugin", null, ["purpur", "paper", "spigot", "bukkit"]],
    ["VANILLA", "datapack", null, ["datapack"]], ["MODRINTH", "mod", "neoforge", ["neoforge"]], ["MODRINTH", "mod", null, []],
    ["PAPER", "modpack", null, []],
  ])("%s %s (pack %s) → %j", (type, kind, pack, want) => expect(modrinthLoadersFor(type, kind as ContentKind, pack)).toEqual(want));
  it("maps CurseForge loaders", () => {
    expect(curseforgeLoaderFor(["quilt", "fabric"])).toBe(5);
    expect(curseforgeLoaderFor(["paper"])).toBeNull();
  });
});
describe("pickLatest", () => {
  const v = (type: "release" | "beta" | "alpha", publishedAt: string) => ({ type, publishedAt });
  const list = [v("beta", "2026-10-03"), v("release", "2026-10-01"), v("alpha", "2026-10-04"), v("release", "2026-09-01")];
  it("release entries only move to releases", () => expect(pickLatest(list, "release")).toBe(list[1]));
  it("beta entries may move to a newer beta", () => expect(pickLatest(list, "beta")).toBe(list[0]));
  it("alpha entries take anything newer", () => expect(pickLatest(list, "alpha")).toBe(list[2]));
  it("new entries fall back to beta when there is no release", () => expect(pickLatest([v("beta", "2026-10-03"), v("alpha", "2026-10-09")], null)?.type).toBe("beta"));
});
describe("request schemas", () => {
  it("rejects a game version with path characters", () => expect(contentSearchQuerySchema.safeParse({ kind: "mod", gameVersion: "../x" }).success).toBe(false));
  it("splits the loaders list and rejects unknown loaders", () => {
    expect(contentSearchQuerySchema.parse({ kind: "mod", loaders: "fabric,quilt" }).loaders).toEqual(["fabric", "quilt"]);
    expect(contentSearchQuerySchema.safeParse({ kind: "mod", loaders: "liteloader" }).success).toBe(false);
  });
  it("caps the offset at 9950 (CurseForge index+pageSize ≤ 10000)", () => expect(contentSearchQuerySchema.safeParse({ kind: "mod", offset: "9951" }).success).toBe(false));
  it("limits resolve selections to 50", () => {
    const sel = Array.from({ length: 51 }, () => ({ projectId: "AANobbMI", versionId: "Yp8wLY1P" }));
    expect(resolveRequestSchema.safeParse({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: ["fabric"] }, selections: sel, present: [], pack: null }).success).toBe(false);
  });
});
