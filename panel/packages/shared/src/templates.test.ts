import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyName, specToTemplate, templateCreateSchema, templateInstantiateSchema } from "./templates.js";
import { specInputSchema, templateSpecSchema } from "./spec.js";

const modded = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-modded.json", import.meta.url), "utf8"));

describe("plantillas", () => {
  it("specToTemplate strips ports, rconPassword and the CurseForge key and keeps the rest", () => {
    const t = specToTemplate({ ...modded, curseforgeApiKey: "k" });
    expect(t).not.toHaveProperty("ports");
    expect(t).not.toHaveProperty("rconPassword");
    expect(t).not.toHaveProperty("curseforgeApiKey");
    const { ports: _p, rconPassword: _r, ...rest } = modded;
    expect(t).toEqual({ ...rest, build: "" });
  });
  it("a template is instantiated as a valid SpecInput by adding only ports", () => {
    const t = specToTemplate(modded);
    expect(specInputSchema.parse({ ...t, ports: { extra: [] } }).ports.game).toBeUndefined();
  });
  it("the template applies the same validations as the spec", () => {
    expect(templateSpecSchema.safeParse({ type: "MODRINTH" }).success).toBe(false);
    expect(templateSpecSchema.safeParse({ env: { CF_API_KEY: "x" } }).success).toBe(false);
  });
  it("create requires a spec or a source server, not both", () => {
    expect(templateCreateSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "A", spec: {}, fromServerId: "x" }).success).toBe(false);
    expect(templateCreateSchema.parse({ name: " A ", spec: {} })).toEqual({ name: "A", description: "", spec: {} });
  });
  it("instantiate validates port and slug", () => {
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", port: 70000 }).success).toBe(false);
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", slug: "Mal Slug" }).success).toBe(false);
    expect(templateInstantiateSchema.parse({ nodeId: "n", name: "X" }).desiredState).toBe("stopped");
  });
  it("copyName", () => {
    expect(copyName("Survival", 1)).toBe("Survival (copy)");
    expect(copyName("Survival", 3)).toBe("Survival (copy 3)");
    expect(copyName("x".repeat(60), 2)).toHaveLength(60);
  });
});
