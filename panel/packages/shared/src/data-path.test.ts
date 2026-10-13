import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DATA_PATH_MAX_BYTES, dataPathError, dataPathPatchError, dataPathsOverlap, pathWithin } from "./data-path.js";
import { specInputSchema, specPatchNullError, specSchema, templateSpecSchema } from "./spec.js";
import { specToTemplate } from "./templates.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const cases = fixture("data-path-cases.json") as { path: string; ok: boolean }[];

describe("cases shared with the Go agent (proto/fixtures/data-path-cases.json)", () => {
  it("the fixture has cases", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [JSON.stringify(c.path), c] as const))("%s", (_name, c) => {
    expect(dataPathError(c.path) === null).toBe(c.ok);
    expect(specSchema.safeParse({ ...base, dataPath: c.path }).success).toBe(c.ok);
  });
  it("length in bytes", () => {
    const ok = "/srv/" + "a".repeat(DATA_PATH_MAX_BYTES - 5);
    expect(dataPathError(ok)).toBeNull();
    expect(dataPathError(ok + "a")).not.toBeNull();
  });
  it("empty is not a path (the field is omitted)", () => {
    expect(specSchema.safeParse({ ...base, dataPath: "" }).success).toBe(false);
  });
});

describe("pathWithin / dataPathsOverlap", () => {
  it("compares by segments, not by text", () => {
    expect(pathWithin("/srv/mc/a", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc", "/srv/mc")).toBe(true);
    expect(pathWithin("/srv/mc-viejo", "/srv/mc")).toBe(false);
    expect(pathWithin("/srv", "/")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc", "/home/lobo/mc/survival")).toBe(true);
    expect(dataPathsOverlap("/home/lobo/mc/a", "/home/lobo/mc/b")).toBe(false);
  });
});

describe("dataPath in the spec", () => {
  it("is kept in specSchema and specInputSchema, not in templates", () => {
    expect(specSchema.parse({ ...base, dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(specInputSchema.parse({ dataPath: "/home/lobo/mc/survival" }).dataPath).toBe("/home/lobo/mc/survival");
    expect(templateSpecSchema.parse({ dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
    expect(specToTemplate({ ...base, dataPath: "/home/lobo/mc/survival" })).not.toHaveProperty("dataPath");
  });
  it("without dataPath the parsed spec does not gain the key (what is stored does not change)", () => {
    expect(specSchema.parse(base)).not.toHaveProperty("dataPath");
  });
  it("does not coexist with scheduled backups", () => {
    const withData = { ...base, dataPath: "/home/lobo/mc/survival" };
    expect(specSchema.safeParse({ ...withData, backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
    expect(specSchema.safeParse({ ...withData, backups: { enabled: false } }).success).toBe(true);
    expect(specInputSchema.safeParse({ dataPath: "/home/lobo/mc/survival", backups: { enabled: true, cron: "0 4 * * *" } }).success).toBe(false);
  });
  it("PATCH: it can only resend the same dataPath; changing it or removing it (null) cannot", () => {
    expect(specPatchNullError({ dataPath: null })).toBeNull();
    const prev = { dataPath: "/home/lobo/mc/survival" };
    expect(dataPathPatchError({}, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/mc/survival" }, prev)).toBeNull();
    expect(dataPathPatchError({ dataPath: null }, prev)).not.toBeNull(); // it would recreate over DATA_ROOT/<slug>/data, empty
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, prev)).not.toBeNull();
    expect(dataPathPatchError({ dataPath: "/home/lobo/otra" }, {})).not.toBeNull();
    expect(dataPathPatchError({ dataPath: null }, {})).toBeNull(); // there was none: nothing changes
  });
});
