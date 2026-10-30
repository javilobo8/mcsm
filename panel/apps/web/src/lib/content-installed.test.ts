import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { installedRows, unresolvedNote } from "./content-installed";
import type { EditableSpec } from "./spec-edit";
import { meta, req } from "./content-fixtures.test-util";

const FAPI = "P7dR8mSH";
const spec: EditableSpec = {
  ...defaultSpecInput(), type: "FABRIC", version: "1.21.1",
  mods: { modrinthProjects: [`${FAPI}:Q2bcdefg`, "my-own-mod", "gvQqBUqZ:Lh3m2kR1", "AANobbMI:Yp8wLY1P"], curseforgeFiles: ["238222:5101366"], urls: [] },
};
const metas = [
  meta({ raw: "AANobbMI:Yp8wLY1P", name: "Sodium", iconUrl: "/api/content/image?url=x", versionLabel: "mc1.21.1-0.6.5", dependencies: [req(FAPI)] }),
  meta({ raw: "gvQqBUqZ:Lh3m2kR1", name: "Lithium", versionLabel: "0.14.3", dependencies: [req(FAPI)] }),
  meta({ raw: `${FAPI}:Q2bcdefg`, name: "Fabric API", versionLabel: "0.119.2" }),
  meta({ raw: "238222:5101366", list: "mods.curseforgeFiles", name: "Just Enough Items", versionLabel: "19.21.0.247" }),
  meta({ raw: "my-own-mod", resolved: false, projectId: null, versionId: null }),
  // A stale answer for an entry that is no longer in the spec is ignored.
  meta({ raw: "OLD00001:v0000001", name: "Old mod", dependencies: [req("238222")] }),
];

describe("installedRows", () => {
  const rows = installedRows(spec, metas, [
    { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P", projectId: "AANobbMI", currentVersionId: "Yp8wLY1P", compatible: true, checked: true, latest: { versionId: "NEWVER01", label: "0.6.6", type: "release", entry: "AANobbMI:NEWVER01" } },
    { list: "mods.curseforgeFiles", entry: "AANobbMI:Yp8wLY1P", projectId: null, currentVersionId: null, compatible: true, checked: true, latest: { versionId: "x", label: "wrong list", type: "release", entry: "x" } },
  ]);
  it("orders selected projects by name, then dependencies, then raw entries", () => {
    expect(rows.map((r) => r.name)).toEqual(["Just Enough Items", "Lithium", "Sodium", "Fabric API", "my-own-mod"]);
  });
  it("fills dependencyOf from the metas of entries still present", () => {
    expect(rows.find((r) => r.name === "Fabric API")?.dependencyOf).toEqual(["Sodium", "Lithium"]);
    expect(rows.find((r) => r.name === "Just Enough Items")?.dependencyOf).toEqual([]);
  });
  it("a raw entry row is shown as typed and unresolved", () => {
    expect(rows.at(-1)).toEqual({
      list: "mods.modrinthProjects", raw: "my-own-mod", name: "my-own-mod", iconUrl: null, platform: "modrinth", versionLabel: null,
      pinned: false, dependencyOf: [], update: null, checked: true, resolved: false, unavailable: null,
    });
  });
  it("an entry not looked up yet is unresolved too", () => {
    expect(installedRows(spec, [], [])).toHaveLength(5);
    expect(installedRows(spec, [], []).every((r) => !r.resolved)).toBe(true);
  });
  it("attaches the update by list and raw", () => {
    expect(rows.find((r) => r.name === "Sodium")).toMatchObject({ pinned: true, versionLabel: "mc1.21.1-0.6.5", iconUrl: "/api/content/image?url=x", update: { label: "0.6.6" } });
    expect(rows.find((r) => r.name === "Just Enough Items")).toMatchObject({ platform: "curseforge", update: null });
  });
  it("an entry whose update check failed says so", () => {
    const r = installedRows(spec, metas, [{ list: "mods.modrinthProjects", entry: "gvQqBUqZ:Lh3m2kR1", projectId: "gvQqBUqZ", currentVersionId: "Lh3m2kR1", compatible: true, latest: null, checked: false }]);
    expect(r.find((x) => x.name === "Lithium")).toMatchObject({ update: null, checked: false });
  });
  it("says why an entry could not be resolved", () => {
    const r = installedRows(spec, [
      meta({ raw: "238222:5101366", list: "mods.curseforgeFiles", resolved: false, projectId: null, versionId: null, unavailable: "no_key" }),
      meta({ raw: "my-own-mod", resolved: false, projectId: null, versionId: null, unavailable: "source" }),
    ], []);
    expect(r.find((x) => x.raw === "238222:5101366")).toMatchObject({ resolved: false, unavailable: "no_key" });
    expect(r.find((x) => x.raw === "my-own-mod")).toMatchObject({ resolved: false, unavailable: "source" });
    expect(r.find((x) => x.raw === "AANobbMI:Yp8wLY1P")).toMatchObject({ resolved: false, unavailable: null });
  });
});

describe("unresolvedNote", () => {
  const row = installedRows(spec, [], []).find((r) => r.raw === "my-own-mod")!;
  it("not found only when the platform answered and does not know it", () => {
    expect(unresolvedNote({ ...row, unavailable: null }, { loading: false, lookupFailed: false })).toBe("not_found");
    expect(unresolvedNote({ ...row, unavailable: "source" }, { loading: false, lookupFailed: false })).toBe("unavailable");
    expect(unresolvedNote({ ...row, unavailable: "no_key" }, { loading: false, lookupFailed: false })).toBe("no_key");
    expect(unresolvedNote({ ...row, unavailable: null }, { loading: true, lookupFailed: false })).toBe("loading");
    expect(unresolvedNote({ ...row, unavailable: null }, { loading: false, lookupFailed: true })).toBe("unavailable");
    expect(unresolvedNote({ ...row, resolved: true }, { loading: false, lookupFailed: false })).toBeNull();
  });
});
