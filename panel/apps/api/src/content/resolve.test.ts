import { pickLatest, type ContentDependencyDto, type ContentVersionDto } from "@mcsm/shared";
import { describe, expect, it } from "vitest";
import { MAX_RESOLVED, compatibleWith, resolveSelection, type ResolveDeps, type ResolveInput } from "./resolve.js";

const TARGET = { gameVersion: "1.21.1", loaders: ["fabric"] };
const NAMES: Record<string, string> = { A: "Alpha", B: "Beta", C: "Gamma", D: "Delta", E: "Epsilon" };

type Dep = [type: ContentDependencyDto["type"], projectId: string | null, versionId?: string];
function v(projectId: string, versionId: string, deps: Dep[] = [], over: Partial<ContentVersionDto> = {}): ContentVersionDto {
  return {
    platform: "modrinth", projectId, versionId, label: versionId, type: "release", publishedAt: `2024-01-0${versionId.slice(-1)}T00:00:00.000Z`,
    gameVersions: ["1.21.1"], loaders: ["fabric"], installable: true, reason: null,
    dependencies: deps.map(([type, p, vid]) => ({ type, projectId: p, versionId: vid ?? null })),
    ...over,
  };
}

/** In-memory ResolveDeps over a list of versions; records each call. */
function fakeDeps(versions: ContentVersionDto[]) {
  const calls: string[] = [];
  const deps: ResolveDeps = {
    version: async (id) => { calls.push(`version ${id}`); return versions.find((x) => x.versionId === id) ?? null; },
    latest: async (pid) => {
      calls.push(`latest ${pid}`);
      return pickLatest(versions.filter((x) => x.projectId === pid && compatibleWith(x, TARGET)), null);
    },
    name: async (pid) => NAMES[pid] ?? pid,
  };
  return { deps, calls };
}

function input(o: { selections: [string, string][]; present?: [string, string, Dep[]?][]; inPack?: string[] }): ResolveInput {
  return {
    list: "mods.modrinthProjects",
    selections: o.selections.map(([projectId, versionId]) => ({ projectId, versionId })),
    present: new Map((o.present ?? []).map(([p, vid, deps]) => [p, {
      versionId: vid, dependencies: (deps ?? []).map(([type, pid, x]) => ({ type, projectId: pid, versionId: x ?? null })),
    }])),
    inPack: new Set(o.inPack ?? []),
    target: TARGET,
  };
}

const rows = (r: Awaited<ReturnType<typeof resolveSelection>>) => r.add.map((e) => [e.projectId, e.versionId, e.selected, e.requiredBy]);

describe("resolveSelection", () => {
  it("adds required dependencies once, with who requires them", async () => {
    // A@a1 requires B (no version) and C@c1; B@b2 requires D; present has D
    const { deps } = fakeDeps([
      v("A", "a1", [["required", "B"], ["required", "C", "c1"]]),
      v("B", "b1"), v("B", "b2", [["required", "D"]]),
      v("C", "c1"),
      v("D", "d1"),
    ]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]], present: [["D", "d1"]] }), deps);
    expect(rows(r)).toEqual([
      ["A", "a1", true, []], ["B", "b2", false, ["Alpha"]], ["C", "c1", false, ["Alpha"]],
    ]);
    expect(r.add.find((e) => e.projectId === "D")).toBeUndefined();
    expect(r.add[1]).toEqual({ list: "mods.modrinthProjects", projectId: "B", versionId: "b2", entry: "B:b2", name: "Beta", selected: false, requiredBy: ["Alpha"] });
    expect(r).toMatchObject({ optional: [], inPack: [], conflicts: [], unresolved: [] });
  });

  it("collects every dependant of a shared dependency", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["required", "C"]]), v("B", "b1", [["required", "C"]]), v("C", "c1")]);
    const r = await resolveSelection(input({ selections: [["A", "a1"], ["B", "b1"]] }), deps);
    expect(rows(r)).toEqual([["A", "a1", true, []], ["B", "b1", true, []], ["C", "c1", false, ["Alpha", "Beta"]]]);
  });

  it("lists optional dependencies without adding them", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["optional", "B"], ["optional", "D"]]), v("B", "b1"), v("D", "d1")]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]], present: [["D", "d1"]] }), deps);
    expect(rows(r)).toEqual([["A", "a1", true, []]]);
    expect(r.optional).toEqual([{ projectId: "B", name: "Beta", requiredBy: ["Alpha"] }]);
  });

  it("an optional dependency that another one requires is added, not listed", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["optional", "C"], ["required", "B"]]), v("B", "b1", [["required", "C"]]), v("C", "c1")]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]] }), deps);
    expect(r.add.map((e) => e.projectId)).toEqual(["A", "B", "C"]);
    expect(r.optional).toEqual([]);
  });

  it("follows a dependency given only by version id", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["required", null, "b1"]]), v("B", "b1"), v("B", "b2")]);
    expect(rows(await resolveSelection(input({ selections: [["A", "a1"]] }), deps))).toEqual([["A", "a1", true, []], ["B", "b1", false, ["Alpha"]]]);
  });

  it("reports an incompatible project already installed", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["incompatible", "D"], ["incompatible", "E"]])]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]], present: [["D", "d1"]] }), deps);
    expect(r.conflicts).toEqual(["Alpha is incompatible with Delta"]);
  });

  it("reports an installed project that declares the new one incompatible", async () => {
    const { deps } = fakeDeps([v("A", "a1")]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]], present: [["D", "d1", [["incompatible", "A"]]]] }), deps);
    expect(r.conflicts).toEqual(["Delta is incompatible with Alpha"]);
  });

  it("does not add what the modpack already brings", async () => {
    const { deps, calls } = fakeDeps([v("A", "a1", [["required", "B"]]), v("B", "b1")]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]], inPack: ["B"] }), deps);
    expect(rows(r)).toEqual([["A", "a1", true, []]]);
    expect(r.inPack).toEqual([{ projectId: "B", name: "Beta" }]);
    expect(calls).not.toContain("latest B");
  });

  it("explains a dependency with no compatible version", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["required", "B"]]), v("B", "b1", [], { gameVersions: ["1.20.1"] })]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]] }), deps);
    expect(rows(r)).toEqual([["A", "a1", true, []]]);
    expect(r.unresolved).toEqual(["Beta (required by Alpha) has no version for fabric 1.21.1"]);
  });

  it("explains a selection whose version does not exist", async () => {
    const { deps } = fakeDeps([]);
    const r = await resolveSelection(input({ selections: [["A", "zz"]] }), deps);
    expect(r.add).toEqual([]);
    expect(r.unresolved).toEqual(["A: version zz not found"]);
  });

  it("replaces a pinned dependency version that does not fit the target", async () => {
    const { deps } = fakeDeps([
      v("A", "a1", [["required", "B", "b1"]]),
      v("B", "b1", [], { loaders: ["forge"] }), v("B", "b2"),
    ]);
    expect(rows(await resolveSelection(input({ selections: [["A", "a1"]] }), deps))).toEqual([["A", "a1", true, []], ["B", "b2", false, ["Alpha"]]]);
  });

  it("terminates on dependency cycles", async () => {
    const { deps } = fakeDeps([v("A", "a1", [["required", "B"]]), v("B", "b1", [["required", "A"]])]);
    const r = await resolveSelection(input({ selections: [["A", "a1"]] }), deps);
    expect(rows(r)).toEqual([["A", "a1", true, ["Beta"]], ["B", "b1", false, ["Alpha"]]]);
  });

  it("caps the resolution at 200 projects", async () => {
    const many = Array.from({ length: MAX_RESOLVED + 1 }, (_, i) => `P${i}`);
    const { deps } = fakeDeps([v("A", "a1", many.map((p): Dep => ["required", p])), ...many.map((p) => v(p, `${p}v1`))]);
    await expect(resolveSelection(input({ selections: [["A", "a1"]] }), deps))
      .rejects.toMatchObject({ status: 400, message: "Too many dependencies to resolve (max. 200)" });
  });
});

describe("compatibleWith", () => {
  it("needs the game version and a shared loader; a version without loaders fits any loader", () => {
    expect(compatibleWith(v("A", "a1"), TARGET)).toBe(true);
    expect(compatibleWith(v("A", "a1", [], { gameVersions: ["1.21"] }), TARGET)).toBe(false);
    expect(compatibleWith(v("A", "a1", [], { loaders: ["forge"] }), TARGET)).toBe(false);
    expect(compatibleWith(v("A", "a1", [], { loaders: ["forge"] }), { gameVersion: "1.21.1", loaders: [] })).toBe(true);
    expect(compatibleWith(v("A", "a1", [], { loaders: [] }), { gameVersion: "1.21.1", loaders: ["paper"] })).toBe(true);
  });
});
