import { describe, expect, it } from "vitest";
import { defaultSpecInput, type ResolveResultDto } from "@mcsm/shared";
import { addSummary, applyResolved, crossPlatformWarnings, dependentsOf, unusedAfterRemoval } from "./content-deps";
import { listOf } from "./content-lists";
import type { EditableSpec } from "./spec-edit";
import { meta, req } from "./content-fixtures.test-util";

const FAPI = "P7dR8mSH";
const sodium = meta({ raw: "AANobbMI:Yp8wLY1P", name: "Sodium", dependencies: [req(FAPI)] });
const lithium = meta({ raw: "gvQqBUqZ:Lh3m2kR1", name: "Lithium", dependencies: [req(FAPI), { projectId: "OPT00001", versionId: null, type: "optional" }] });
const fabricApi = meta({ raw: `${FAPI}:Q2bcdefg`, name: "Fabric API", dependencies: [] });

const result = (add: ResolveResultDto["add"]): ResolveResultDto => ({ add, optional: [], inPack: [], conflicts: [], unresolved: [] });
const entry = (projectId: string, versionId: string, selected: boolean, name = projectId) =>
  ({ list: "mods.modrinthProjects" as const, projectId, versionId, entry: `${projectId}:${versionId}`, name, selected, requiredBy: [] });

describe("dependentsOf", () => {
  it("a dependency is listed with the names of who requires it", () => {
    expect(dependentsOf(FAPI, [sodium, lithium, fabricApi])).toEqual(["Sodium", "Lithium"]);
    expect(dependentsOf("OPT00001", [sodium, lithium])).toEqual([]);
    expect(dependentsOf("AANobbMI", [sodium, lithium, fabricApi])).toEqual([]);
  });
  it("falls back to the raw entry when the name is unknown", () => {
    expect(dependentsOf(FAPI, [meta({ raw: "foo", dependencies: [req(FAPI)] })])).toEqual(["foo"]);
  });
});

describe("unusedAfterRemoval", () => {
  it("removing Sodium offers to remove Fabric API only when nothing else needs it", () => {
    expect(unusedAfterRemoval([sodium], [lithium, fabricApi])).toEqual([]);
    expect(unusedAfterRemoval([sodium], [fabricApi])).toEqual([fabricApi]);
    expect(unusedAfterRemoval([sodium, lithium], [fabricApi])).toEqual([fabricApi]);
  });
  it("follows chains of dependencies that become unused", () => {
    const lib = meta({ raw: "LIB00001:v0000001", name: "Lib" });
    const api = meta({ raw: `${FAPI}:Q2bcdefg`, name: "Fabric API", dependencies: [req("LIB00001")] });
    expect(unusedAfterRemoval([sodium], [api, lib])).toEqual([api, lib]);
  });
  it("never offers a dependency that is not present", () => {
    expect(unusedAfterRemoval([sodium], [lithium])).toEqual([]);
  });
});

describe("applyResolved", () => {
  it("applyResolved writes pinned entries to the right list without duplicates", () => {
    const spec: EditableSpec = { ...defaultSpecInput(), type: "FABRIC", version: "1.21.1", mods: { modrinthProjects: [`${FAPI}:Q2bcdefg`], curseforgeFiles: [], urls: [] } };
    const r = result([entry("AANobbMI", "Yp8wLY1P", true), entry(FAPI, "Q2bcdefg", false), { ...entry("DP000001", "dv000001", false), list: "datapacks.modrinthProjects" }]);
    const next = applyResolved(spec, r);
    expect(listOf(next, "mods.modrinthProjects")).toEqual([`${FAPI}:Q2bcdefg`, "AANobbMI:Yp8wLY1P"]);
    expect(listOf(next, "datapacks.modrinthProjects")).toEqual(["DP000001:dv000001"]);
  });
  it("replaces another version of a project already in the list", () => {
    const spec: EditableSpec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["AANobbMI:OLDVERS1", "lithium"], curseforgeFiles: [], urls: [] } };
    expect(listOf(applyResolved(spec, result([entry("AANobbMI", "Yp8wLY1P", true)])), "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P", "lithium"]);
  });
  it("replaces a project typed as a slug, by the id its lookup resolved (never a second jar)", () => {
    const spec: EditableSpec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["sodium", "lithium", "fabric-api"], curseforgeFiles: [], urls: [] } };
    const metas = [
      meta({ raw: "sodium", projectId: "AANobbMI", versionId: null }),
      meta({ raw: "lithium", projectId: "gvQqBUqZ", versionId: null }),
      meta({ raw: "fabric-api", projectId: FAPI, versionId: null }),
      meta({ raw: "fabric-api", list: "plugins.modrinthProjects", projectId: "OTHER001", versionId: null }), // another list: ignored
    ];
    // A selection, and a dependency the resolver pinned.
    const next = applyResolved(spec, result([entry("AANobbMI", "Yp8wLY1P", true), entry(FAPI, "Q2bcdefg", false)]), metas);
    expect(listOf(next, "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P", "lithium", `${FAPI}:Q2bcdefg`]);
  });
  it("collapses a project listed twice (slug and pinned id) into the resolved entry", () => {
    const spec: EditableSpec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["sodium", "lithium", "AANobbMI:OLDVERS1"], curseforgeFiles: [], urls: [] } };
    const metas = [meta({ raw: "sodium", projectId: "AANobbMI", versionId: null }), meta({ raw: "AANobbMI:OLDVERS1" })];
    expect(listOf(applyResolved(spec, result([entry("AANobbMI", "Yp8wLY1P", true)]), metas), "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P", "lithium"]);
    // Already exactly there: the spec is left as it is.
    const pinned: EditableSpec = { ...spec, mods: { ...spec.mods!, modrinthProjects: ["AANobbMI:Yp8wLY1P"] } };
    expect(applyResolved(pinned, result([entry("AANobbMI", "Yp8wLY1P", true)]), metas)).toBe(pinned);
  });
});

describe("addSummary", () => {
  it("counts the selected projects and their dependencies", () => {
    expect(addSummary(result([entry("A0000001", "a", true)]))).toBe("Add 1 project");
    expect(addSummary(result([entry("A0000001", "a", true), entry("B0000001", "b", true), entry("C", "c", false), entry("D", "d", false), entry("E", "e", false)])))
      .toBe("Add 2 projects + 3 dependencies");
    expect(addSummary(result([entry("A0000001", "a", true), entry("C", "c", false)]))).toBe("Add 1 project + 1 dependency");
    expect(addSummary(result([]))).toBe("Nothing new to add");
  });
});

describe("crossPlatformWarnings", () => {
  it("warns when a project looks installed from the other platform", () => {
    const cf = meta({ raw: "306612:5383715", list: "mods.curseforgeFiles", name: "Fabric API", slug: "fabric-api" });
    expect(crossPlatformWarnings([{ name: "Fabric API", slug: "fabric-api" }], [cf])).toEqual(["Fabric API is already installed from CurseForge"]);
    expect(crossPlatformWarnings([{ name: "fabric api", slug: "fapi" }], [cf])).toEqual(["fabric api is already installed from CurseForge"]);
    expect(crossPlatformWarnings([{ name: "Sodium", slug: "sodium" }], [cf])).toEqual([]);
  });
  it("names Modrinth when the other entry comes from Modrinth", () => {
    const mr = meta({ raw: "P7dR8mSH:Q2bcdefg", name: "Fabric API", slug: "fabric-api" });
    expect(crossPlatformWarnings([{ name: "Fabric API", slug: "fabric-api" }], [mr])).toEqual(["Fabric API is already installed from Modrinth"]);
  });
});
