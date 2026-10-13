import { describe, expect, it } from "vitest";
import { buildUnavailableReason, specChanged, blurVersionAction, ageText, buildLabel, buildOptions, freeTextOption, hasUnstableBuilds, hasVersionList, startsUnstable, versionOptions } from "./versions";

const LIST = [
  { id: "26.4-snapshot-3", stable: false }, { id: "26.3", stable: true }, { id: "26.3-rc-3", stable: false },
  { id: "1.21.11", stable: true }, { id: "1.21.4", stable: true }, { id: "25w14a", stable: false },
];

describe("versionOptions", () => {
  it("without searching: the type's specials and stable ones; test versions only with the switch", () => {
    expect(versionOptions("VANILLA", LIST, { query: "", showUnstable: false })).toEqual({
      specials: [{ id: "LATEST", label: "LATEST — the latest stable" }, { id: "SNAPSHOT", label: "SNAPSHOT — the latest snapshot" }],
      stable: ["26.3", "1.21.11", "1.21.4"], unstable: [], hidden: 0, freeText: null,
    });
    expect(versionOptions("PAPER", LIST, { query: "", showUnstable: true })).toMatchObject({
      specials: [{ id: "LATEST" }], unstable: ["26.4-snapshot-3", "26.3-rc-3", "25w14a"],
    });
  });
  it("when searching, test versions are included too, and what was typed that is not listed as “Use”", () => {
    expect(versionOptions("PAPER", LIST, { query: "26.3", showUnstable: false })).toMatchObject({ specials: [], stable: ["26.3"], unstable: ["26.3-rc-3"], freeText: null });
    expect(versionOptions("PAPER", LIST, { query: " 1.8.9 ", showUnstable: false })).toMatchObject({ stable: [], unstable: [], freeText: "1.8.9" });
  });
  it("at most MAX_OPTIONS per group; the rest is counted", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `1.0.${i}`, stable: true }));
    const o = versionOptions("PAPER", many, { query: "", showUnstable: false });
    expect(o.stable).toHaveLength(200);
    expect(o.hidden).toBe(50);
  });
});

describe("freeTextOption", () => {
  it("only valid versions that are not in the list nor LATEST/SNAPSHOT", () => {
    expect(freeTextOption("1.8.9", LIST)).toBe("1.8.9");
    expect(freeTextOption("26.3", LIST)).toBeNull();
    expect(freeTextOption("latest", LIST)).toBeNull();
    expect(freeTextOption("Snapshot", LIST)).toBeNull();
    expect(freeTextOption("1 2", LIST)).toBeNull();
    expect(freeTextOption("../x", LIST)).toBeNull();
    expect(freeTextOption("", LIST)).toBeNull();
  });
});

describe("build selector", () => {
  it("label by type; null if it does not support build", () => {
    expect(buildLabel("FABRIC")).toBe("Fabric loader version");
    expect(buildLabel("PAPER")).toBe("Paper build");
    expect(buildLabel("VANILLA")).toBeNull();
    expect(hasUnstableBuilds("NEOFORGE")).toBe(true);
    expect(hasUnstableBuilds("PAPER")).toBe(false);
  });
  it("stable by default, the recommended one marked and the current one always present", () => {
    const builds = [
      { id: "47.4.27", stable: true, recommended: false }, { id: "47.4.26-beta", stable: false, recommended: false },
      { id: "47.4.0", stable: true, recommended: true },
    ];
    expect(buildOptions(builds, "", false)).toEqual([{ value: "47.4.27", label: "47.4.27" }, { value: "47.4.0", label: "47.4.0 (recommended)" }]);
    expect(buildOptions(builds, "", true).map((o) => o.label)).toContain("47.4.26-beta (beta)");
    expect(buildOptions(builds, "40.0.1", false)[0]).toEqual({ value: "40.0.1", label: "40.0.1" });
    expect(buildOptions(builds, "47.4.26-beta", false).map((o) => o.value)).toContain("47.4.26-beta");
  });
});

describe("others", () => {
  it("hasVersionList / startsUnstable / ageText", () => {
    expect(hasVersionList("FORGE")).toBe(true);
    expect(hasVersionList("MODRINTH")).toBe(false);
    expect(startsUnstable("26.4-snapshot-3")).toBe(true);
    expect(startsUnstable("1.21.4")).toBe(false);
    expect(startsUnstable("LATEST")).toBe(false);
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ageText("2026-10-13T11:45:00Z", now)).toBe("15 min ago");
    expect(ageText("2026-10-13T10:00:00Z", now)).toBe("2 h ago");
    expect(ageText("2026-10-10T12:00:00Z", now)).toBe("3 days ago");
  });
});

describe("blurVersionAction / specChanged", () => {
  it("no changes: nothing; only spaces: trim; real change: apply", () => {
    expect(blurVersionAction("1.20.1", "1.20.1")).toBe("none");
    expect(blurVersionAction("1.20.1", " 1.20.1 ")).toBe("trim");
    expect(blurVersionAction("1.20.1", "1.21.4")).toBe("apply");
    expect(blurVersionAction("1.20.1", "1.21.4 ")).toBe("apply");
  });
  it("specChanged compares version, Java and build (absent build = empty)", () => {
    const a = { version: "1", imageTag: "java21" };
    expect(specChanged(a, { ...a })).toBe(false);
    expect(specChanged(a, { ...a, build: "" })).toBe(false);
    expect(specChanged(a, { ...a, build: "7" })).toBe(true);
    expect(specChanged(a, { ...a, version: "2" })).toBe(true);
    expect(specChanged(a, { ...a, imageTag: "java17" })).toBe(true);
  });
});

describe("buildUnavailableReason", () => {
  it("LATEST/SNAPSHOT ask for a specific version; a non-queryable version does not support build; a specific one does", () => {
    expect(buildUnavailableReason("LATEST")).toBe("Choose a specific Minecraft version to pin the build.");
    expect(buildUnavailableReason("snapshot")).toBe("Choose a specific Minecraft version to pin the build.");
    expect(buildUnavailableReason("1.14 Pre-Release 5")).toBe("This version does not support pinning the build.");
    expect(buildUnavailableReason("1.21.4")).toBeNull();
  });
});
