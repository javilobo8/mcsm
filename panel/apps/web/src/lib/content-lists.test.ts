import { describe, expect, it } from "vitest";
import { defaultSpecInput } from "@mcsm/shared";
import { listOf, presentFor, removeEntries, replaceEntry, withList } from "./content-lists";
import type { EditableSpec } from "./spec-edit";

const paper: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.1" };
const fabric: EditableSpec = {
  ...defaultSpecInput(), type: "FABRIC", version: "1.21.1",
  mods: { modrinthProjects: ["AANobbMI:Yp8wLY1P", "lithium"], curseforgeFiles: ["238222:5101366"], urls: ["https://x/y.jar"] },
  datapacks: { modrinthProjects: ["terralith"] },
};

describe("content lists", () => {
  it("listOf reads a list and an absent section as empty", () => {
    expect(listOf(fabric, "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P", "lithium"]);
    expect(listOf(fabric, "plugins.curseforgeFiles")).toEqual([]);
    expect(listOf(paper, "datapacks.modrinthProjects")).toEqual([]);
  });
  it("withList creates plugins without a phantom curseforgeFiles key", () => {
    const s = withList(paper, "plugins.modrinthProjects", ["luckperms"]);
    expect(s.plugins).toEqual({ modrinthProjects: ["luckperms"], spigetResources: [], urls: [] });
  });
  it("withList creates curseforgeFiles on plugins only when that is the list being set", () => {
    expect(withList(paper, "plugins.curseforgeFiles", ["123:456"]).plugins).toEqual({ modrinthProjects: [], spigetResources: [], urls: [], curseforgeFiles: ["123:456"] });
  });
  it("withList creates mods and datapacks with their defaults and keeps the other fields", () => {
    expect(withList(paper, "mods.curseforgeFiles", ["1:2"]).mods).toEqual({ modrinthProjects: [], curseforgeFiles: ["1:2"], urls: [] });
    expect(withList(paper, "datapacks.modrinthProjects", ["x"]).datapacks).toEqual({ modrinthProjects: ["x"] });
    expect(withList(fabric, "mods.modrinthProjects", []).mods).toEqual({ modrinthProjects: [], curseforgeFiles: ["238222:5101366"], urls: ["https://x/y.jar"] });
  });
  it("presentFor lists every entry of a platform with its list", () => {
    expect(presentFor(fabric, "modrinth")).toEqual([
      { list: "mods.modrinthProjects", entry: "AANobbMI:Yp8wLY1P" },
      { list: "mods.modrinthProjects", entry: "lithium" },
      { list: "datapacks.modrinthProjects", entry: "terralith" },
    ]);
    expect(presentFor(fabric, "curseforge")).toEqual([{ list: "mods.curseforgeFiles", entry: "238222:5101366" }]);
  });
  it("removeEntries drops the given raws and never creates a section", () => {
    expect(listOf(removeEntries(fabric, "mods.modrinthProjects", ["lithium"]), "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P"]);
    expect(removeEntries(paper, "mods.modrinthProjects", ["x"])).toBe(paper);
  });
  it("replaceEntry swaps one raw in place without duplicating", () => {
    expect(listOf(replaceEntry(fabric, "mods.modrinthProjects", "lithium", "gvQqBUqZ:abcdefgh"), "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P", "gvQqBUqZ:abcdefgh"]);
    expect(listOf(replaceEntry(fabric, "mods.modrinthProjects", "lithium", "AANobbMI:Yp8wLY1P"), "mods.modrinthProjects")).toEqual(["AANobbMI:Yp8wLY1P"]);
  });
});
