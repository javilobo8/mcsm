import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import { createErrorStep, createRequest, creationSource, parseNewServerSearch, stepBlock, summarizeSpec } from "./wizard";

describe("new server wizard", () => {
  it("from a template calls the template endpoint and only passes the port if given", () => {
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: " Survival ", start: true })).toEqual({
      url: "/api/templates/t1/servers", body: { nodeId: "n", name: "Survival", desiredState: "running" },
    });
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: "S", port: 25570, start: false }).body).toMatchObject({ port: 25570, desiredState: "stopped" });
  });
  it("encodes the template id in the path", () => {
    expect(createRequest({ templateId: "a/b?c" }, { nodeId: "n", name: "S", start: true }).url).toBe("/api/templates/a%2Fb%3Fc/servers");
  });
  it("from scratch sends the spec with the game port only if given", () => {
    const spec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const r = createRequest({ spec }, { nodeId: "n", name: "Fabric", start: true });
    expect(r.url).toBe("/api/servers");
    expect(r.body.spec).toMatchObject({ type: "FABRIC", mods: { modrinthProjects: ["lithium"] }, ports: { extra: [] } });
    expect((r.body.spec as { ports: object }).ports).not.toHaveProperty("game");
    expect(createRequest({ spec }, { nodeId: "n", name: "F", port: 25599, start: true }).body.spec).toMatchObject({ ports: { game: 25599 } });
  });
  it("summarizes the spec", () => {
    const t = templateSpecSchema.parse({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" }, memory: "6G", whitelist: { enabled: true, players: ["Lobo"] }, mods: { modrinthProjects: ["a", "b"] } });
    expect(summarizeSpec(t)).toEqual(expect.arrayContaining([
      { label: "Type", value: "Modrinth modpack" },
      { label: "Modpack", value: "cobblemon-fabric" },
      { label: "Memory", value: "6G" },
      { label: "Mods", value: "2 mods" },
      { label: "Whitelist", value: "1 player" },
    ]));
    expect(summarizeSpec(t).map((l) => l.label)).not.toContain("Scheduled backups");
  });
  it("the backup schedule that the template brings appears in the summary", () => {
    const t = templateSpecSchema.parse({ type: "PAPER", backups: { enabled: true, cron: "0 */6 * * *", keepCount: 20, keepDays: 0 } });
    expect(summarizeSpec(t)).toContainEqual({ label: "Scheduled backups", value: "0 */6 * * * (every 6 hours) · at most 20 backups" });
  });
});

describe("?template=", () => {
  it("accepts a non-empty id and discards the rest", () => {
    expect(parseNewServerSearch({ template: "t1" })).toEqual({ template: "t1" });
    expect(parseNewServerSearch({ template: "" })).toEqual({});
    expect(parseNewServerSearch({ template: 5 })).toEqual({});
    expect(parseNewServerSearch({ template: ["a"], otro: "x" })).toEqual({});
    expect(parseNewServerSearch({})).toEqual({});
  });
});

describe("step blocking", () => {
  const ok = { source: "scratch" as const, templateLoaded: true, specError: null, fieldErrors: {}, nodeId: "n", name: "S", port: "" };
  it("step 1: invalid spec, field errors or missing template block and explain", () => {
    expect(stepBlock(1, ok)).toBeNull();
    expect(stepBlock(1, { ...ok, specError: "modpack.slugOrUrl: required" })).toBe("modpack.slugOrUrl: required");
    expect(stepBlock(1, { ...ok, fieldErrors: { "sf-memory": "x" } })).toMatch(/1 field with an error/);
    expect(stepBlock(1, { ...ok, fieldErrors: { a: "x", b: "y" } })).toMatch(/2 fields with errors/);
    expect(stepBlock(1, { ...ok, source: "t1", templateLoaded: false })).toMatch(/template/i);
    expect(stepBlock(1, { ...ok, source: "t1", templateLoaded: true, specError: "ignored", fieldErrors: {} })).toBeNull();
  });
  it("step 2: node, name and port", () => {
    expect(stepBlock(2, ok)).toBeNull();
    expect(stepBlock(2, { ...ok, nodeId: "" })).toMatch(/node/i);
    expect(stepBlock(2, { ...ok, name: "  " })).toMatch(/name/i);
    expect(stepBlock(2, { ...ok, port: "70000" })).toMatch(/port/i);
    expect(stepBlock(2, { ...ok, port: "abc" })).toMatch(/port/i);
    expect(stepBlock(2, { ...ok, port: "25570" })).toBeNull();
    expect(stepBlock(2, { ...ok, source: "t1", templateLoaded: false })).toMatch(/template/i);
  });
});

describe("creation error", () => {
  it("a 409 (slug or port in use) goes back to step 2; the rest stay on 3", () => {
    expect(createErrorStep(409)).toBe(2);
    expect(createErrorStep(502)).toBe(3);
    expect(createErrorStep(undefined)).toBe(3);
  });
});

describe("source when pressing Create", () => {
  const spec = { ...defaultSpecInput(), type: "FABRIC" };
  it("from scratch uses the spec; with a template, its id", () => {
    expect(creationSource("scratch", undefined, spec)).toEqual({ spec });
    expect(creationSource("t1", { id: "t1" }, spec)).toEqual({ templateId: "t1" });
  });
  it("if the chosen template no longer exists it does NOT fall back to “from scratch”", () => {
    expect(creationSource("t1", undefined, spec)).toBeNull();
  });
});

describe("summarizeSpec: build (plan 10)", () => {
  it("the pinned build appears with its type's label, right after the version", () => {
    const lines = summarizeSpec({ ...defaultSpecInput(), type: "PAPER", version: "1.20.1", build: "178" });
    expect(lines.slice(1, 3)).toEqual([{ label: "Minecraft version", value: "1.20.1" }, { label: "Paper build", value: "178" }]);
    expect(summarizeSpec({ ...defaultSpecInput(), type: "PAPER" }).map((l) => l.label)).not.toContain("Paper build");
  });
});
