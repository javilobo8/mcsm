import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import {
  buildSpecPatch, editableFromTemplate, editableSpec, kvToText, listToText, parseKv, parseList, replaceOtherProperties,
  setProperty, splitProperties, validateSpec, withType, withVersion, parseLines, validateListItems, typeChangeNotice, type EditableSpec,
} from "./spec-edit";
import { PROPERTY_DEFS, typeKind } from "./spec-catalog";

describe("lists and key=value", () => {
  it("parseList accepts lines and commas, removes empties and spaces", () => {
    expect(parseList(" lithium\nsodium, ferritecore:beta\n\n")).toEqual(["lithium", "sodium", "ferritecore:beta"]);
    expect(listToText(["a", "b"])).toBe("a\nb");
    expect(listToText(undefined)).toBe("");
  });
  it("parseKv ignores comments and rejects lines without =", () => {
    expect(parseKv("# hello\nmotd=My = server\n max-players = 10 ")).toEqual({ motd: "My = server", "max-players": "10" });
    expect(() => parseKv("motd")).toThrow(/key=value/);
    expect(kvToText({ a: "1", b: "2" })).toBe("a=1\nb=2");
  });
});

describe("properties", () => {
  it("separates the typed ones, sets/removes one and replaces the others", () => {
    const props = { motd: "x", "max-players": "5", "custom-x": "1" };
    expect(splitProperties(props)).toEqual({ typed: { motd: "x", "max-players": "5" }, other: { "custom-x": "1" } });
    expect(setProperty(props, "motd", "")).toEqual({ "max-players": "5", "custom-x": "1" });
    expect(setProperty(props, "pvp", "false")).toMatchObject({ pvp: "false" });
    expect(replaceOtherProperties(props, { "other-y": "2" })).toEqual({ motd: "x", "max-players": "5", "other-y": "2" });
  });
  it("the catalog has ~20 properties and known types", () => {
    expect(PROPERTY_DEFS.length).toBeGreaterThanOrEqual(20);
    expect(typeKind("FABRIC")).toBe("mods");
    expect(typeKind("AUTO_CURSEFORGE")).toBe("modpack");
    expect(typeKind("MOHIST")).toBe("other");
  });
});

describe("withType", () => {
  it("a modpack type creates the modpack section and a normal one removes it", () => {
    const base = defaultSpecInput();
    const mp = withType(base, "MODRINTH");
    expect(mp.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "", versionId: "", loader: "" });
    const cf = withType({ ...mp, modpack: { ...mp.modpack!, slugOrUrl: "pack", loader: "fabric" } }, "AUTO_CURSEFORGE");
    expect(cf.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "", versionId: "", loader: "" }); // the slug is not carried between platforms
    const paper = withType(cf, "PAPER");
    expect(paper).not.toHaveProperty("modpack");
    expect(paper.type).toBe("PAPER");
  });
});

describe("buildSpecPatch", () => {
  const original = { type: "PAPER", memory: "4G", properties: { motd: "a" }, whitelist: { enabled: true, players: ["Lobo"] }, backups: { cron: "0 4 * * *" }, rconPassword: "x" };
  it("only sends what changed and null for what was removed; never touches keys it does not edit", () => {
    const edited = { type: "PAPER", memory: "6G", properties: { motd: "a" } };
    expect(buildSpecPatch(original, edited)).toEqual({ memory: "6G", whitelist: null });
  });
  it("starting from editableSpec there are no spurious changes", () => {
    expect(buildSpecPatch(original, { ...editableSpec(original), memory: "6G" })).toEqual({ memory: "6G" });
  });
  it("never sends null for required sections; [] is sent as an empty section", () => {
    expect(buildSpecPatch({ type: "PAPER", memory: "4G", ops: ["a"] }, { type: "PAPER", ops: [] })).toEqual({ ops: [] });
    expect(buildSpecPatch({ type: "PAPER", memory: "4G", resources: { cpus: 0, memLimit: "" } }, { type: "PAPER" })).toEqual({});
  });
  it("key order does not count as a change", () => {
    expect(buildSpecPatch({ properties: { a: "1", b: "2" } }, { properties: { b: "2", a: "1" } })).toEqual({});
  });
});

describe("validateSpec", () => {
  it("returns the error with the field path", () => {
    expect(validateSpec(withType(defaultSpecInput(), "MODRINTH"), "server")).toMatch(/^modpack\.slugOrUrl: /);
    expect(validateSpec(defaultSpecInput(), "server")).toBeNull();
  });
  it("in templates it ignores the ports", () => {
    const t = editableFromTemplate(templateSpecSchema.parse({ type: "PAPER" }));
    expect(t.ports).toEqual({ extra: [] });
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "template")).toBeNull();
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "server")).toMatch(/ports\.game/);
  });
});

describe("parseLines and validateListItems", () => {
  it("parseLines does not split on commas", () => {
    expect(parseLines("a,b\n  c \n\n")).toEqual(["a,b", "c"]);
  });
  it("detects spaces, commas and non-http URLs", () => {
    expect(validateListItems("entry", ["lithium", "ferritecore:beta"])).toBeNull();
    expect(validateListItems("entry", ["lithium sodium"])).toMatch(/lithium sodium/);
    expect(validateListItems("entry", ["a,b"])).not.toBeNull();
    expect(validateListItems("url", ["https://x.org/a.jar"])).toBeNull();
    expect(validateListItems("url", ["ftp://x/a.jar"])).not.toBeNull();
    expect(validateListItems("digits", ["28140", "abc"])).toMatch(/abc/);
  });
});

describe("typeChangeNotice", () => {
  const withMp = withType(defaultSpecInput(), "MODRINTH");
  const filled = { ...withMp, modpack: { ...withMp.modpack!, slugOrUrl: "cobblemon" } };
  it("warns when discarding, creating or resetting the modpack and stays silent if there is no effect", () => {
    expect(typeChangeNotice(filled, "PAPER")).toMatch(/discards.*cobblemon/);
    expect(typeChangeNotice(defaultSpecInput(), "MODRINTH")).toMatch(/creates an empty Modpack section/);
    expect(typeChangeNotice(filled, "AUTO_CURSEFORGE")).toMatch(/clears the current modpack/);
    expect(typeChangeNotice(defaultSpecInput(), "FABRIC")).toBeNull();
    expect(typeChangeNotice(filled, "MODRINTH")).toBeNull();
  });
});

describe("validators for Properties, Advanced and Resources", () => {
  it("properties: rejects reserved ones and invalid names", async () => {
    const { validateExtraProperties } = await import("./spec-edit");
    expect(validateExtraProperties({ "spawn-npcs": "true" })).toBeNull();
    for (const k of ["server-port", "enable-rcon", "rcon.port", "rcon.password"]) expect(validateExtraProperties({ [k]: "1" })).toContain(k);
    expect(validateExtraProperties({ "Bad Key": "1" })).toContain("Bad Key");
    // A key with a typed field is not accepted in "Other": otherwise it would move and clear the textarea while typing.
    expect(validateExtraProperties({ motd: "x" })).toContain("field");
  });
  it("env: rejects reserved ones, CF_API_KEY with its own message and invalid names", async () => {
    const { validateEnv } = await import("./spec-edit");
    expect(validateEnv({ USE_AIKAR_FLAGS: "true" })).toBeNull();
    expect(validateEnv({ MEMORY: "4G" })).toContain("MEMORY");
    expect(validateEnv({ RCON_PORT: "1" })).toContain("RCON_PORT");
    expect(validateEnv({ CF_API_KEY: "x" })).toContain("separately");
    expect(validateEnv({ "1BAD": "x" })).toContain("1BAD");
  });
  it("memory: format and limit >= memory", async () => {
    const { validateMemory, validateMemLimit } = await import("./spec-edit");
    expect(validateMemory("4G")).toBeNull();
    for (const bad of ["", "0G", "04G", "4", "4GB", "-1G", "4 G"]) expect(validateMemory(bad)).not.toBeNull();
    expect(validateMemLimit("", "4G")).toBeNull();
    expect(validateMemLimit("5G", "4G")).toBeNull();
    expect(validateMemLimit("2G", "4G")).not.toBeNull();
    expect(validateMemLimit("3x", "4G")).not.toBeNull();
  });
  it("ListItemKind player validates names and UUIDs", () => {
    expect(validateListItems("player", ["Lobo", "069a79f4-44e9-4726-a5be-fca90e38aaf5"])).toBeNull();
    expect(validateListItems("player", ["not valid!"])).toContain("not valid!");
  });
  it("extra ports: RCON 25575 and ranges", async () => {
    const { validateExtraPorts } = await import("./spec-edit");
    expect(validateExtraPorts([{ host: 19132, container: 19132, proto: "udp", label: "" }])).toBeNull();
    expect(validateExtraPorts([{ host: 30000, container: 25575, proto: "tcp", label: "" }])).toContain("25575");
    expect(validateExtraPorts([{ host: 0, container: 1, proto: "tcp", label: "" }])).toContain("#1");
  });
});

describe("numeric field resync", () => {
  it("echo and in-progress edits are not overwritten", async () => {
    const { shouldResyncNumber: r, parseNumberText } = await import("./spec-edit");
    expect(parseNumberText("0.")).toBe(0);
    expect(parseNumberText("0,5")).toBe(0.5);
    expect(parseNumberText("x")).toBeNaN(); // invalid is not empty
    expect(parseNumberText("  ")).toBeUndefined();
    expect(r({ text: "0", incoming: 0, emitted: 0 })).toBe(false);
    expect(r({ text: "0.", incoming: 0, emitted: 0 })).toBe(false);
    expect(r({ text: "0.5", incoming: 0.5, emitted: 0.5 })).toBe(false);
    // CPUs: 0 is saved but the prop goes back to undefined; it is not a remote change
    expect(r({ text: "0", incoming: undefined, emitted: 0, zeroIsEmpty: true })).toBe(false);
    expect(r({ text: "0.", incoming: undefined, emitted: 0, zeroIsEmpty: true })).toBe(false);
    // without zeroIsEmpty, undefined vs 0 are different (the text "0" is 0)
    expect(r({ text: "0", incoming: undefined, emitted: 0 })).toBe(true);
    // real remote replacement
    expect(r({ text: "4", incoming: 8, emitted: 4 })).toBe(true);
    expect(r({ text: "4", incoming: undefined, emitted: 4 })).toBe(true);
    // invalid text on screen + remote replacement (reload, discard) with empty or another value: it resyncs
    expect(r({ text: "x", incoming: undefined, emitted: 4 })).toBe(true);
    expect(r({ text: "x", incoming: 8, emitted: 4 })).toBe(true);
    expect(r({ text: "x", incoming: undefined, emitted: 4, zeroIsEmpty: true })).toBe(true);
    // …but not if the parent just repeats the last emitted value
    expect(r({ text: "x", incoming: 4, emitted: 4 })).toBe(false);
  });
});

describe("reading a NumberField", () => {
  it("integers: empty, valid, decimals, garbage and range", async () => {
    const { readNumberField: read } = await import("./spec-edit");
    const o = { label: "Players", integer: true, min: 1, max: 10 };
    expect(read("", o)).toEqual({ ok: true, value: undefined });
    expect(read(" 7 ", o)).toEqual({ ok: true, value: 7 });
    for (const bad of ["1.5", "5.", "x", "0x10", "1e3", "-1", "0", "11"]) expect(read(bad, o), bad).toEqual({ ok: false, error: "Players: must be an integer between 1 and 10" });
  });
  it("decimals: the intermediate states while typing (0. and 0,) are valid, with no transient error", async () => {
    const { readNumberField: read } = await import("./spec-edit");
    const o = { label: "CPUs", integer: false, min: 0, max: 256 };
    expect(read("0.", o)).toEqual({ ok: true, value: 0 });
    expect(read("0,", o)).toEqual({ ok: true, value: 0 });
    expect(read("0.5", o)).toEqual({ ok: true, value: 0.5 });
    expect(read("1,25", o)).toEqual({ ok: true, value: 1.25 });
    for (const bad of [".", ",", "1.2.3", "-1", "300", "x"]) expect(read(bad, o).ok, bad).toBe(false);
  });
});

describe("Players against the free env", () => {
  it("with the section present, OPS/OPS_FILE and WHITELIST/WHITELIST_FILE/ENABLE_WHITELIST in the env are an error of the section", async () => {
    const { playersEnvErrors } = await import("./spec-edit");
    const base = defaultSpecInput();
    expect(playersEnvErrors({ ...base, env: { OPS: "Lobo,Pepe", ENABLE_WHITELIST: "false" } })).toEqual({ "sf-ops-env": null, "sf-whitelist-env": null });
    const both = playersEnvErrors({ ...base, ops: ["Lobo"], whitelist: { enabled: true, players: [] }, env: { OPS: "Lobo,Pepe", OPS_FILE: "x", ENABLE_WHITELIST: "false", EXISTING_OPS_FILE: "MERGE" } });
    expect(both["sf-ops-env"]).toMatch(/OPS[\s\S]*OPS_FILE/);
    expect(both["sf-ops-env"]).not.toMatch(/EXISTING/);
    expect(both["sf-whitelist-env"]).toMatch(/ENABLE_WHITELIST/);
  });
  it("the ids are computed errors of the Players tab (they are not purged for not being in the DOM)", async () => {
    const { VIRTUAL_ERROR_IDS } = await import("./form-errors");
    const { tabOfField } = await import("@/components/spec-form/spec-form");
    for (const id of ["sf-ops-env", "sf-whitelist-env"]) {
      expect(VIRTUAL_ERROR_IDS.has(id)).toBe(true);
      expect(tabOfField(id)).toBe("players");
    }
  });
});

describe("withVersion (plan 10)", () => {
  const base: EditableSpec = { ...defaultSpecInput(), type: "PAPER", version: "1.21.4", imageTag: "java21", build: "178" };
  it("clears the build when the version changes and adjusts the catalog's Java", () => {
    const r = withVersion(base, "26.3");
    expect(r.spec).toMatchObject({ version: "26.3", build: "", imageTag: "java25" });
    expect(r.notice).toBe("Java adjusted to java25 (the one 26.3 requires)");
    expect(withVersion(base, "1.12.2").spec.imageTag).toBe("java8");
    expect(withVersion({ ...base, imageTag: "latest" }, "1.20.1").spec.imageTag).toBe("java17");
  });
  it("choosing the current version again does not touch Java or build", () => {
    const cur = { ...base, imageTag: "java17" };
    expect(withVersion(cur, "1.21.4")).toEqual({ spec: cur, notice: null });
  });
  it("same Java: no notice; unrecognized version: Java is not touched", () => {
    expect(withVersion(base, "1.21.11")).toMatchObject({ notice: null, spec: { imageTag: "java21", build: "" } });
    expect(withVersion(base, "25w14craftmine")).toMatchObject({ notice: null, spec: { imageTag: "java21" } });
  });
  it("a custom tag is not overwritten; it only warns if it is not enough", () => {
    const custom = { ...base, imageTag: "java21-graalvm" };
    expect(withVersion(custom, "26.3")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: "The java21-graalvm image is not enough for 26.3: it needs Java 25" });
    expect(withVersion(custom, "1.20.1")).toMatchObject({ spec: { imageTag: "java21-graalvm" }, notice: null });
  });
  it("an old spec without build does not gain the key (no phantom diff)", () => {
    const { build: _build, ...old } = base;
    const r = withVersion(old as EditableSpec, "1.21.11");
    expect(r.spec).not.toHaveProperty("build");
    expect(buildSpecPatch(old as EditableSpec, r.spec)).toEqual({ version: "1.21.11" });
  });
  it("withType clears the build only when the type changes", () => {
    expect(withType(base, "FABRIC").build).toBe("");
    expect(withType(base, "PAPER").build).toBe("178");
  });
});
