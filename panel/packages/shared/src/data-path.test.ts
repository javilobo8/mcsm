import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_PATH_MAX_BYTES, dataPathError, dataPathPatchError, dataPathsOverlap, pathWithin } from "./data-path.js";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { specToTemplate } from "./templates.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("data-path-cases.json") as { path: string; ok: boolean }[];

describe("casos compartidos con el agente Go (proto/fixtures/data-path-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [JSON.stringify(c.path), c] as const))("%s", (_name, c) => {
    expect(dataPathError(c.path) === null).toBe(c.ok);
    expect(specSchema.safeParse({ ...base, dataPath: c.path }).success).toBe(c.ok);
  });
  it("longitud en bytes", () => {
    const ok = "/srv/" + "a".repeat(DATA_PATH_MAX_BYTES - 5);
    expect(dataPathError(ok)).toBeNull();
    expect(dataPathError(ok + "a")).not.toBeNull();
  });
  it("vacío no es una ruta (el campo se omite)", () => {
    expect(specSchema.safeParse({ ...base, dataPath: "" }).success).toBe(false);
  });
});

describe("pathWithin / dataPathsOverlap", () => {
  it("compara por tramos, no por texto", () => {
    expect(pathWithin("/srv/mc/a", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc-viejo", "/srv/mc")).toBe(false);
    expect(pathWithin("/srv", "/")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc", "/home/lobo/mc/survival")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc/a", "/home/lobo/mc/b")).toBe(false);
  });
});

describe("dataPath en la spec", () => {
  it("se conserva en specSchema y specInputSchema, no en plantillas", () => {
    expect(specSchema.parse({ ...base, dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(specInputSchema.parse({ dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(templateSpecSchema.parse({ dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
    expect(specToTemplate({ ...base, dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
  });
  it("sin dataPath la spec parseada no gana la clave (no cambia lo que se guarda)", () => {
    expect(specSchema.parse(base)).not.toHaveProperty("dataPath");
  });
  it("no convive con copias programadas", () => {
    const withData = { ...base, dataPath: "/home/lobo/mc/survival" };
    expect(specSchema.safeParse({ ...withData, backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
    expect(specSchema.safeParse({ ...withData, backups: { enabled: false } }).success).toBe(true);
    expect(specInputSchema.safeParse({ dataPath: "/home/lobo/mc/survival", backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
  });
  it("PATCH: solo puede reenviar el mismo dataPath; cambiarlo o quitarlo (null) no", () => {
    expect(specPatchNullError({ dataPath: null })).toBeNull();
    const prev = { dataPath: "/home/lobo/mc/survival" };
    expect(dataPathPatchError({}, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/mc/survival" }, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: null }, prev)).not.toBeNull(); // recrearía sobre DATA_ROOT/<slug>/data, vacía
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, prev)).not.toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, {})).not.toBeNull();
    expect(dataPathPatchError({ dataPath: null }, {})).toBeNull(); // no había: no cambia nada
  });
});
