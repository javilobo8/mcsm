import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { BUILD_ENV, buildError, compareVersions, isFloatingVersion, isStableVersion, javaMajor, minJavaTag } from "./versions.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("build-cases.json") as { name: string; type: string; version: string; build: string; env?: Record<string, string>; ok: boolean }[];

describe("casos compartidos con el agente Go (proto/fixtures/build-cases.json)", () => {
  it("la fixture tiene casos", () => expect(cases.length).toBeGreaterThanOrEqual(20));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, type: c.type, version: c.version, build: c.build, env: c.env ?? base.env });
    expect(r.success).toBe(c.ok);
  });
});

describe("build en la spec", () => {
  it("por defecto vacío; viaja en plantillas; null en un PATCH es 400", () => {
    expect(specInputSchema.parse({}).build).toBe("");
    expect(templateSpecSchema.parse({ type: "PAPER", version: "1.20.1", build: "178" }).build).toBe("178");
    expect(specPatchNullError({ build: null })).toMatch(/build/);
  });
  it("los errores apuntan al campo y explican el motivo", () => {
    expect(buildError({ type: "VANILLA", version: "1.21.4", build: "1", env: {} })).toEqual({ path: ["build"], message: expect.stringMatching(/VANILLA no admite/) });
    expect(buildError({ type: "PAPER", version: "latest", build: "1", env: {} })?.message).toMatch(/versión concreta/);
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "1", env: { PAPER_BUILD: "2" } }))
      .toEqual({ path: ["env", "PAPER_BUILD"], message: expect.stringMatching(/Quita la variable PAPER_BUILD/) });
    expect(buildError({ type: "PAPER", version: "1.20.1", build: "", env: { PAPER_BUILD: "2" } })).toBeNull();
  });
  it("cada tipo con build tiene su variable de itzg (Folia sin guion bajo)", () => {
    expect(BUILD_ENV).toEqual({
      PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD", FABRIC: "FABRIC_LOADER_VERSION",
      QUILT: "QUILT_LOADER_VERSION", FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
    });
  });
});

describe("compareVersions", () => {
  const newestFirst = (xs: string[]) => [...xs].sort((a, b) => compareVersions(b, a));
  it("por componentes numéricos; el año va antes que 1.x y la release antes que su pre-release", () => {
    expect(newestFirst(["1.21.9", "1.21.10", "26.1", "1.21", "26.1.2", "1.21.11-rc3", "1.21.11"]))
      .toEqual(["26.1.2", "26.1", "1.21.11", "1.21.11-rc3", "1.21.10", "1.21.9", "1.21"]);
  });
  it("pre-releases entre sí y builds largos", () => {
    expect(newestFirst(["0.20.0-beta.9", "0.24.0", "0.20.0-beta.10", "0.25.0-beta.1"])).toEqual(["0.25.0-beta.1", "0.24.0", "0.20.0-beta.10", "0.20.0-beta.9"]);
    expect(newestFirst(["26.3.0.9", "26.3.0.76", "26.3.0.75-beta"])).toEqual(["26.3.0.76", "26.3.0.75-beta", "26.3.0.9"]);
    expect(newestFirst(["1.7.10_pre4", "1.7.10", "1.8"])).toEqual(["1.8", "1.7.10", "1.7.10_pre4"]);
    expect(compareVersions("1.21", "1.21.0")).toBe(0);
  });
});

describe("minJavaTag y compañía", () => {
  it.each([
    ["LATEST", "java25"], ["snapshot", "java25"], ["26.3", "java25"], ["26.4-snapshot-3", "java25"], ["26.3-rc-3", "java25"],
    ["1.21.11", "java21"], ["1.21", "java21"], ["1.20.5", "java21"], ["1.20.5-pre1", "java21"],
    ["1.20.4", "java17"], ["1.18.2", "java17"], ["1.17", "java17"],
    ["1.16.5", "java8"], ["1.12.2", "java8"], ["1.7.10", "java8"],
    ["24w14a", "java21"], ["24w13a", "java17"], ["21w19a", "java17"], ["21w18a", "java8"],
    ["25w14craftmine", null], ["b1.7.3", null], ["", null],
  ] as const)("%s → %s", (v, tag) => expect(minJavaTag(v)).toBe(tag));
  it("javaMajor lee el número de la etiqueta", () => {
    expect(javaMajor("java21-graalvm")).toBe(21);
    expect(javaMajor("java8")).toBe(8);
    expect(javaMajor("latest")).toBeNull();
  });
  it("estable = solo dígitos y puntos; LATEST/SNAPSHOT son flotantes", () => {
    expect(isStableVersion("1.21.11")).toBe(true);
    expect(isStableVersion("1.21.11-rc3")).toBe(false);
    expect(isStableVersion("25w14a")).toBe(false);
    expect(isFloatingVersion("Latest")).toBe(true);
    expect(isFloatingVersion("1.21")).toBe(false);
  });
});
