import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serverPatchSchema, specInputSchema, specPatchNullError, specSchema } from "./spec.js";
import { CURSEFORGE_API_KEY_RE, envSectionConflicts, usesCurseForge } from "./spec-content.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const modded = fixture("spec-modded.json");
const cases = fixture("spec-content-cases.json") as { name: string; ok: boolean; merge: Record<string, unknown> }[];

describe("cases shared with the Go agent (proto/fixtures/spec-content-cases.json)", () => {
  it("the fixture has cases", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, ...c.merge });
    expect(r.success, r.success ? "" : r.error.issues[0]?.message).toBe(c.ok);
  });
});

describe("spec with content", () => {
  it("accepts spec-modded.json unchanged", () => {
    expect(specSchema.parse(modded)).toEqual({ ...modded, build: "" });
  });
  it("the Plan 1 spec still has no new fields after parsing (what is stored does not change)", () => {
    const parsed = specSchema.parse(base);
    for (const k of ["modpack", "mods", "plugins", "whitelist", "ops"]) expect(parsed).not.toHaveProperty(k);
  });
  it("fills in defaults inside the present sections", () => {
    const parsed = specInputSchema.parse({ mods: {}, whitelist: { players: ["Lobo"] } });
    expect(parsed.mods).toEqual({ modrinthProjects: [], curseforgeFiles: [], urls: [] });
    expect(parsed.whitelist).toEqual({ enabled: false, players: ["Lobo"] });
  });
  it("absent is not empty: ops and whitelist are kept exactly as they arrive", () => {
    expect(specInputSchema.parse({})).not.toHaveProperty("ops");
    expect(specInputSchema.parse({ ops: [] }).ops).toEqual([]);
    expect(specInputSchema.parse({ whitelist: { players: [] } }).whitelist?.players).toEqual([]);
    expect(specInputSchema.parse({})).not.toHaveProperty("whitelist");
  });
  it("discards curseforgeApiKey if it comes from outside (it is never persisted)", () => {
    const parsed = specSchema.parse({ ...base, curseforgeApiKey: "secreto" });
    expect(parsed).not.toHaveProperty("curseforgeApiKey");
  });
  it("errors carry the field path", () => {
    const r = specInputSchema.safeParse({ type: "MODRINTH" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["modpack"]);
  });
  it("CURSEFORGE_API_KEY_RE: the same cases as TestCurseForgeAPIKeyValidated (Go)", () => {
    for (const ok of ["$2a$10$abc/DEF.ghi", "k".repeat(200), "!~"]) expect(CURSEFORGE_API_KEY_RE.test(ok), ok).toBe(true);
    for (const bad of ["", "with space", "nul\u0000", "newline\n", "tab\t", "del\u007f", "clé", "k".repeat(201)]) expect(CURSEFORGE_API_KEY_RE.test(bad), bad).toBe(false);
  });
  it("env that overrides a Players section: same message as the agent and on the env.<VAR> path", () => {
    const r = specSchema.safeParse({ ...base, ops: ["Lobo"], env: { OPS: "Lobo,Pepe" } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["env", "OPS"]);
      expect(r.error.issues[0]?.message).toBe("Remove the OPS variable from the environment variables (Advanced): operators are managed in the Players section");
    }
    expect(envSectionConflicts({ env: { ENABLE_WHITELIST: "false", OPS: "x" }, whitelist: { enabled: true } })).toEqual([
      { key: "ENABLE_WHITELIST", section: "whitelist", message: "Remove the ENABLE_WHITELIST variable from the environment variables (Advanced): the whitelist is managed in the Players section" },
    ]);
    expect(envSectionConflicts({ env: { OPS: "x", WHITELIST: "y" } })).toEqual([]);
  });
  it("usesCurseForge", () => {
    expect(usesCurseForge(base)).toBe(false);
    expect(usesCurseForge({ mods: { curseforgeFiles: ["jei"] } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "AUTO_CURSEFORGE" } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "MODRINTH" } })).toBe(false);
  });
});

describe("datapacks and CurseForge plugins", () => {
  it("old specs keep no plugins.curseforgeFiles key", () => {
    const s = specInputSchema.parse({ ...base, plugins: { modrinthProjects: [], spigetResources: [], urls: [] } });
    expect(Object.hasOwn(s.plugins!, "curseforgeFiles")).toBe(false);
  });
  it("CurseForge plugins need the API key", () => expect(usesCurseForge({ plugins: { curseforgeFiles: ["1:2"] } })).toBe(true));
  it("datapacks: null deletes the section in a PATCH", () => expect(specPatchNullError({ datapacks: null })).toBeNull());
  it("datapacks list is capped at 1000", () => {
    expect(specInputSchema.safeParse({ ...base, datapacks: { modrinthProjects: Array.from({ length: 1001 }, (_, i) => `p${i}`) } }).success).toBe(false);
  });
  it("serverPatchSchema accepts backupFirst", () => expect(serverPatchSchema.parse({ spec: {}, backupFirst: true }).backupFirst).toBe(true));
});
