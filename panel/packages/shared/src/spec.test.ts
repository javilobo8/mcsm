import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema, defaultSpecInput } from "./spec.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-example.json", import.meta.url), "utf8"));

describe("specSchema", () => {
  it("acepta la fixture compartida sin cambios", () => {
    const parsed = specSchema.parse(fixture);
    expect(parsed).toEqual(fixture);
  });
  it("rechaza env reservadas", () => {
    expect(() => specSchema.parse({ ...fixture, env: { RCON_PASSWORD: "x" } })).toThrow(/reservada/);
  });
  it("rechaza memLimit menor que memory", () => {
    expect(() => specSchema.parse({ ...fixture, resources: { cpus: 0, memLimit: "2G" } })).toThrow(/memLimit/);
  });
  it("rechaza memoria con formato raro", () => {
    expect(() => specSchema.parse({ ...fixture, memory: "4 gigas" })).toThrow();
  });
  it("rechaza rconPassword corta", () => {
    expect(() => specSchema.parse({ ...fixture, rconPassword: "abc" })).toThrow();
  });
});

describe("specInputSchema", () => {
  it("rellena defaults y no exige rconPassword ni puerto", () => {
    const parsed = specInputSchema.parse({ type: "VANILLA", version: "LATEST" });
    expect(parsed.memory).toBe("2G");
    expect(parsed.imageTag).toBe("java21");
    expect(parsed.ports.extra).toEqual([]);
    expect(parsed.ports.game).toBeUndefined();
    expect(parsed.restartPolicy).toBe("unless-stopped");
    expect(parsed.resources).toEqual({ cpus: 0, memLimit: "" });
  });
  it("defaultSpecInput valida", () => {
    expect(() => specInputSchema.parse(defaultSpecInput())).not.toThrow();
  });
});
