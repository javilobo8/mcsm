import { describe, expect, it } from "vitest";
import { defaultSpecInput, type PackInfoDto } from "@mcsm/shared";
import { browserTabs, browseTarget, canSearch, FLOATING_REASON, PACK_UNKNOWN_REASON } from "./content-target";
import type { EditableSpec } from "./spec-edit";

const spec = (type: string, version: string): EditableSpec => ({ ...defaultSpecInput(), type, version });
const pack: PackInfoDto = {
  platform: "modrinth", projectId: "P0000001", slug: "cobblemon", versionId: "V0000001", name: "Cobblemon", versionLabel: "1.6",
  iconUrl: null, minecraftVersion: "1.21.1", loader: "fabric", loaderVersion: "0.16.9", contents: [], contentsKnown: true, reason: null,
};

describe("browserTabs", () => {
  it("Paper gets no CurseForge tab unless F1 allows it", () => {
    expect(browserTabs("PAPER", { curseforgePlugins: false })).toEqual([{ platform: "modrinth", kind: "plugin" }, { platform: "modrinth", kind: "datapack" }]);
    expect(browserTabs("FOLIA", { curseforgePlugins: true })).toEqual([
      { platform: "modrinth", kind: "plugin" }, { platform: "modrinth", kind: "datapack" }, { platform: "curseforge", kind: "plugin" },
    ]);
  });
  it("Vanilla browses datapacks and modpacks", () => {
    expect(browserTabs("VANILLA", { curseforgePlugins: true })).toEqual([
      { platform: "modrinth", kind: "datapack" }, { platform: "modrinth", kind: "modpack" }, { platform: "curseforge", kind: "modpack" },
    ]);
  });
  it("mod loaders and modpack types browse mods, datapacks and modpacks", () => {
    const tabs = [
      { platform: "modrinth", kind: "mod" }, { platform: "modrinth", kind: "datapack" }, { platform: "modrinth", kind: "modpack" },
      { platform: "curseforge", kind: "mod" }, { platform: "curseforge", kind: "modpack" },
    ];
    for (const t of ["FABRIC", "FORGE", "NEOFORGE", "QUILT", "MODRINTH", "AUTO_CURSEFORGE"]) expect(browserTabs(t, { curseforgePlugins: true })).toEqual(tabs);
  });
  it("FTB and unknown types only browse datapacks", () => {
    expect(browserTabs("FTBA", { curseforgePlugins: true })).toEqual([{ platform: "modrinth", kind: "datapack" }]);
    expect(browserTabs("MOHIST", { curseforgePlugins: true })).toEqual([{ platform: "modrinth", kind: "datapack" }]);
  });
});

describe("browseTarget", () => {
  it("a floating version blocks browsing mods but not modpacks", () => {
    expect(browseTarget(spec("FABRIC", "LATEST"), "mod", null)).toEqual({ ok: false, reason: FLOATING_REASON, pinTo: "release" });
    expect(browseTarget(spec("PAPER", "snapshot"), "datapack", null)).toEqual({ ok: false, reason: FLOATING_REASON, pinTo: "release" });
    expect(browseTarget(spec("FABRIC", "LATEST"), "modpack", null)).toEqual({ ok: true, target: { gameVersion: "", loaders: [] } });
    expect(browseTarget(spec("FABRIC", "1.21.1"), "modpack", null)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: [] } });
  });
  it("a concrete version gives the loaders of the type", () => {
    expect(browseTarget(spec("QUILT", "1.21.1"), "mod", null)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["quilt", "fabric"] } });
    expect(browseTarget(spec("PAPER", "1.21.1"), "plugin", null)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["paper", "spigot", "bukkit"] } });
    expect(browseTarget(spec("PAPER", "1.21.1"), "datapack", null)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["datapack"] } });
  });
  it("modpack types wait for the pack's loader and take its Minecraft version", () => {
    const mp = { ...spec("MODRINTH", "LATEST"), modpack: { platform: "MODRINTH" as const, slugOrUrl: "P0000001", versionId: "V0000001", loader: "" as const } };
    expect(browseTarget(mp, "mod", null)).toEqual({ ok: false, reason: "Waiting for the modpack's details (loader and Minecraft version)", waiting: true });
    expect(browseTarget(mp, "mod", pack)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["fabric"] } });
    expect(browseTarget(mp, "datapack", pack)).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["datapack"] } });
  });
  it("modpack types stop waiting when the details failed or lack what the search needs", () => {
    const mp = { ...spec("MODRINTH", "LATEST"), modpack: { platform: "MODRINTH" as const, slugOrUrl: "cobblemon", versionId: "V0000001", loader: "" as const } };
    expect(browseTarget(mp, "mod", null, "Version not found on Modrinth")).toEqual({ ok: false, reason: "Version not found on Modrinth" });
    expect(browseTarget(mp, "mod", { ...pack, loader: null })).toEqual({ ok: false, reason: PACK_UNKNOWN_REASON });
    expect(browseTarget(mp, "datapack", { ...pack, loader: null })).toEqual({ ok: true, target: { gameVersion: "1.21.1", loaders: ["datapack"] } });
    expect(browseTarget(mp, "datapack", { ...pack, minecraftVersion: null })).toEqual({ ok: false, reason: PACK_UNKNOWN_REASON });
    expect(PACK_UNKNOWN_REASON).toBe("The modpack does not say which loader and Minecraft version it runs: the browser cannot tell what fits");
  });
});

describe("canSearch", () => {
  it("only a browsable tab shows the filters, the search box and Add; a blocked one shows its notice alone", () => {
    const ok = browseTarget(spec("FABRIC", "1.21.1"), "mod", null);
    expect(canSearch(ok, false)).toBe(true);
    expect(canSearch(ok, true)).toBe(false); // CurseForge without a key
    expect(canSearch(browseTarget(spec("FABRIC", "LATEST"), "mod", null), false)).toBe(false); // pending "Pin Minecraft version"
    expect(canSearch(browseTarget(spec("FABRIC", "SNAPSHOT"), "datapack", null), false)).toBe(false);
    expect(canSearch(browseTarget(spec("FABRIC", "LATEST"), "modpack", null), false)).toBe(true);
  });
});
