import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { applyUpdates, backupOffer, compatFindings, removedEntries, uncheckedEntries } from "./content-compat";
import { listOf } from "./content-lists";
import type { EditableSpec } from "./spec-edit";
import { meta } from "./content-fixtures.test-util";

const spec: EditableSpec = {
  ...defaultSpecInput(), type: "FABRIC", version: "1.21.4",
  mods: { modrinthProjects: ["AANobbMI:Yp8wLY1P", "lithium", "P7dR8mSH:Q2bcdefg"], curseforgeFiles: [], urls: [] },
};
const sodium = meta({ raw: "AANobbMI:Yp8wLY1P", name: "Sodium", gameVersions: ["1.21.1"] });
const lithium = meta({ raw: "lithium", projectId: "gvQqBUqZ", versionId: "Lh3m2kR1", name: "Lithium", gameVersions: ["1.21.1"] });
const fabricApi = meta({ raw: "P7dR8mSH:Q2bcdefg", name: "Fabric API", gameVersions: ["1.21.1", "1.21.4"] });
const forgeOnly = meta({ raw: "FORGEMOD:v0000001", name: "Forge mod", gameVersions: ["1.21.4"], loaders: ["forge"] });

describe("compatFindings", () => {
  it("compatFindings flags pinned entries without the new Minecraft version", () => {
    expect(compatFindings(spec, [sodium, lithium, fabricApi], { gameVersion: "1.21.4", loaders: ["fabric"] })).toEqual([
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", name: "Sodium", problem: "incompatible" },
    ]);
  });
  it("flags pinned entries for another loader", () => {
    const s = { ...spec, mods: { ...spec.mods!, modrinthProjects: ["FORGEMOD:v0000001"] } };
    expect(compatFindings(s, [forgeOnly], { gameVersion: "1.21.4", loaders: ["fabric"] })).toEqual([
      { list: "mods.modrinthProjects", entry: "FORGEMOD:v0000001", name: "Forge mod", problem: "incompatible" },
    ]);
  });
  it("compatFindings flags pinned entries on a floating version", () => {
    expect(compatFindings({ ...spec, version: "LATEST" }, [sodium, lithium, fabricApi], null)).toEqual([
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", name: "Sodium", problem: "floating" },
      { list: "mods.modrinthProjects", entry: "P7dR8mSH:Q2bcdefg", name: "Fabric API", problem: "floating" },
    ]);
  });
  it("ignores entries no longer in the spec, unresolved ones and a target not known yet", () => {
    expect(compatFindings({ ...spec, mods: undefined }, [sodium], { gameVersion: "1.21.4", loaders: ["fabric"] })).toEqual([]);
    expect(compatFindings(spec, [{ ...sodium, resolved: false }], { gameVersion: "1.21.4", loaders: ["fabric"] })).toEqual([]);
    expect(compatFindings(spec, [sodium], null)).toEqual([]);
  });
});

describe("applyUpdates", () => {
  it("applyUpdates replaces entries and names those without a compatible version", () => {
    const r = applyUpdates(spec, [
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", projectId: "AANobbMI", currentVersionId: "Yp8wLY1P", compatible: false, checked: true, latest: { versionId: "NEWVER01", label: "0.6.6", type: "release", entry: "AANobbMI:NEWVER01" } },
      { list: "mods.modrinthProjects", entry: "P7dR8mSH:Q2bcdefg", projectId: "P7dR8mSH", currentVersionId: "Q2bcdefg", compatible: false, checked: true, latest: null },
      { list: "mods.modrinthProjects", entry: "lithium", projectId: "gvQqBUqZ", currentVersionId: null, compatible: true, checked: true, latest: null },
    ]);
    expect(listOf(r.spec, "mods.modrinthProjects")).toEqual(["AANobbMI:NEWVER01", "lithium", "P7dR8mSH:Q2bcdefg"]);
    expect(r.withoutVersion).toEqual(["P7dR8mSH:Q2bcdefg"]);
  });
  it("an entry whose check failed is unknown, not without a version", () => {
    const r = applyUpdates(spec, [
      { list: "mods.modrinthProjects", entry: "P7dR8mSH:Q2bcdefg", projectId: "P7dR8mSH", currentVersionId: "Q2bcdefg", compatible: false, latest: null, checked: false },
    ]);
    expect(r).toEqual({ spec, withoutVersion: [] });
  });
});

describe("removedEntries and backupOffer", () => {
  const removed = { ...spec, mods: { ...spec.mods!, modrinthProjects: ["lithium", "P7dR8mSH:Q2bcdefg"] } };
  it("an update of the same project is not a removal", () => {
    expect(removedEntries(spec, removed)).toEqual([{ list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P" }]);
    const updated = { ...spec, mods: { ...spec.mods!, modrinthProjects: ["AANobbMI:NEWVER01", "lithium", "P7dR8mSH:Q2bcdefg"] } };
    expect(removedEntries(spec, updated)).toEqual([]);
  });
  it("dropping the whole section removes every entry", () => {
    expect(removedEntries(spec, { ...spec, mods: undefined })).toHaveLength(3);
  });
  it("backupOffer: removal with a world → true; removal with hasWorld false → false; unknown world → true", () => {
    expect(backupOffer({ base: spec, edited: removed, packChange: "none", hasWorld: true })).toBe(true);
    expect(backupOffer({ base: spec, edited: removed, packChange: "none", hasWorld: false })).toBe(false);
    expect(backupOffer({ base: spec, edited: removed, packChange: "none", hasWorld: null })).toBe(true);
    expect(backupOffer({ base: spec, edited: spec, packChange: "none", hasWorld: true })).toBe(false);
  });
  it("pack changes that can break a world offer a backup; install and upgrade do not", () => {
    for (const p of ["downgrade", "switch", "uninstall", "unknown"] as const) expect(backupOffer({ base: spec, edited: spec, packChange: p, hasWorld: null })).toBe(true);
    for (const p of ["install", "upgrade"] as const) expect(backupOffer({ base: spec, edited: spec, packChange: p, hasWorld: true })).toBe(false);
  });
});

describe("uncheckedEntries", () => {
  it("pinned entries the platform could not be asked about are not checked; not-found and raw ones are not listed", () => {
    const s = { ...spec, mods: { ...spec.mods!, curseforgeFiles: ["238222:5101366", "jei"] } };
    const metas = [
      { ...sodium, resolved: false, unavailable: "source" as const },
      meta({ raw: "238222:5101366", list: "mods.curseforgeFiles", resolved: false, projectId: null, versionId: null, unavailable: "no_key" }),
      meta({ raw: "jei", list: "mods.curseforgeFiles", resolved: false, projectId: null, versionId: null, unavailable: "no_key" }),
      { ...fabricApi, resolved: false, unavailable: null },
    ];
    expect(uncheckedEntries(s, metas)).toEqual([
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", reason: "source" },
      { list: "mods.curseforgeFiles", entry: "238222:5101366", reason: "no_key" },
    ]);
  });
  it("ignores answers for entries no longer in the spec", () => {
    expect(uncheckedEntries({ ...spec, mods: undefined }, [{ ...sodium, resolved: false, unavailable: "source" }])).toEqual([]);
  });
});
