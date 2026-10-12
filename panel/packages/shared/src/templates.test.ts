import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyName, specToTemplate, templateCreateSchema, templateInstantiateSchema } from "./templates.js";
import { specInputSchema, templateSpecSchema } from "./spec.js";

const modded = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-modded.json", import.meta.url), "utf8"));

describe("plantillas", () => {
  it("specToTemplate quita puertos, rconPassword y la key de CurseForge y conserva el resto", () => {
    const t = specToTemplate({ ...modded, curseforgeApiKey: "k" });
    expect(t).not.toHaveProperty("ports");
    expect(t).not.toHaveProperty("rconPassword");
    expect(t).not.toHaveProperty("curseforgeApiKey");
    const { ports: _p, rconPassword: _r, ...rest } = modded;
    expect(t).toEqual(rest);
  });
  it("una plantilla se instancia como SpecInput válida añadiendo solo puertos", () => {
    const t = specToTemplate(modded);
    expect(specInputSchema.parse({ ...t, ports: { extra: [] } }).ports.game).toBeUndefined();
  });
  it("la plantilla aplica las mismas validaciones que la spec", () => {
    expect(templateSpecSchema.safeParse({ type: "MODRINTH" }).success).toBe(false);
    expect(templateSpecSchema.safeParse({ env: { CF_API_KEY: "x" } }).success).toBe(false);
  });
  it("crear exige spec o servidor de origen, no ambos", () => {
    expect(templateCreateSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "A", spec: {}, fromServerId: "x" }).success).toBe(false);
    expect(templateCreateSchema.parse({ name: " A ", spec: {} })).toEqual({ name: "A", description: "", spec: {} });
  });
  it("instanciar valida puerto y slug", () => {
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", port: 70000 }).success).toBe(false);
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", slug: "Mal Slug" }).success).toBe(false);
    expect(templateInstantiateSchema.parse({ nodeId: "n", name: "X" }).desiredState).toBe("stopped");
  });
  it("copyName", () => {
    expect(copyName("Survival", 1)).toBe("Survival (copia)");
    expect(copyName("Survival", 3)).toBe("Survival (copia 3)");
    expect(copyName("x".repeat(60), 2)).toHaveLength(60);
  });
});
