import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema } from "./spec.js";
import { usesCurseForge } from "./spec-content.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const modded = fixture("spec-modded.json");
const cases = fixture("spec-content-cases.json") as { name: string; ok: boolean; merge: Record<string, unknown> }[];

describe("casos compartidos con el agente Go (proto/fixtures/spec-content-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, ...c.merge });
    expect(r.success, r.success ? "" : r.error.issues[0]?.message).toBe(c.ok);
  });
});

describe("spec con contenido", () => {
  it("acepta spec-modded.json sin cambios", () => {
    expect(specSchema.parse(modded)).toEqual(modded);
  });
  it("la spec del Plan 1 sigue sin campos nuevos tras parsear (no cambia lo que se guarda)", () => {
    const parsed = specSchema.parse(base);
    for (const k of ["modpack", "mods", "plugins", "whitelist", "ops"]) expect(parsed).not.toHaveProperty(k);
  });
  it("rellena defaults dentro de las secciones presentes", () => {
    const parsed = specInputSchema.parse({ mods: {}, whitelist: { players: ["Lobo"] } });
    expect(parsed.mods).toEqual({ modrinthProjects: [], curseforgeFiles: [], urls: [] });
    expect(parsed.whitelist).toEqual({ enabled: false, players: ["Lobo"] });
  });
  it("ausente no es vacío: ops y whitelist se conservan tal cual llegan", () => {
    expect(specInputSchema.parse({})).not.toHaveProperty("ops");
    expect(specInputSchema.parse({ ops: [] }).ops).toEqual([]);
    expect(specInputSchema.parse({ whitelist: { players: [] } }).whitelist?.players).toEqual([]);
    expect(specInputSchema.parse({})).not.toHaveProperty("whitelist");
  });
  it("descarta curseforgeApiKey si llega desde fuera (nunca se persiste)", () => {
    const parsed = specSchema.parse({ ...base, curseforgeApiKey: "secreto" });
    expect(parsed).not.toHaveProperty("curseforgeApiKey");
  });
  it("los errores llevan la ruta del campo", () => {
    const r = specInputSchema.safeParse({ type: "MODRINTH" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["modpack"]);
  });
  it("usesCurseForge", () => {
    expect(usesCurseForge(base)).toBe(false);
    expect(usesCurseForge({ mods: { curseforgeFiles: ["jei"] } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "AUTO_CURSEFORGE" } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "MODRINTH" } })).toBe(false);
  });
});
