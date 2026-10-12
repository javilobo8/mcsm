import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import { createErrorStep, createRequest, parseNewServerSearch, stepBlock, summarizeSpec } from "./wizard";

describe("asistente de nuevo servidor", () => {
  it("desde plantilla llama al endpoint de la plantilla y solo pasa el puerto si se dio", () => {
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: " Survival ", start: true })).toEqual({
      url: "/api/templates/t1/servers", body: { nodeId: "n", name: "Survival", desiredState: "running" },
    });
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: "S", port: 25570, start: false }).body).toMatchObject({ port: 25570, desiredState: "stopped" });
  });
  it("codifica el id de la plantilla en la ruta", () => {
    expect(createRequest({ templateId: "a/b?c" }, { nodeId: "n", name: "S", start: true }).url).toBe("/api/templates/a%2Fb%3Fc/servers");
  });
  it("desde cero envía la spec con el puerto de juego solo si se dio", () => {
    const spec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const r = createRequest({ spec }, { nodeId: "n", name: "Fabric", start: true });
    expect(r.url).toBe("/api/servers");
    expect(r.body.spec).toMatchObject({ type: "FABRIC", mods: { modrinthProjects: ["lithium"] }, ports: { extra: [] } });
    expect((r.body.spec as { ports: object }).ports).not.toHaveProperty("game");
    expect(createRequest({ spec }, { nodeId: "n", name: "F", port: 25599, start: true }).body.spec).toMatchObject({ ports: { game: 25599 } });
  });
  it("resume la spec", () => {
    const t = templateSpecSchema.parse({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" }, memory: "6G", whitelist: { enabled: true, players: ["Lobo"] }, mods: { modrinthProjects: ["a", "b"] } });
    expect(summarizeSpec(t)).toEqual(expect.arrayContaining([
      { label: "Tipo", value: "Modpack de Modrinth" },
      { label: "Modpack", value: "cobblemon-fabric" },
      { label: "Memoria", value: "6G" },
      { label: "Mods", value: "2 mods" },
      { label: "Whitelist", value: "1 jugador" },
    ]));
  });
});

describe("?template=", () => {
  it("acepta un id no vacío y descarta lo demás", () => {
    expect(parseNewServerSearch({ template: "t1" })).toEqual({ template: "t1" });
    expect(parseNewServerSearch({ template: "" })).toEqual({});
    expect(parseNewServerSearch({ template: 5 })).toEqual({});
    expect(parseNewServerSearch({ template: ["a"], otro: "x" })).toEqual({});
    expect(parseNewServerSearch({})).toEqual({});
  });
});

describe("bloqueo de pasos", () => {
  const ok = { source: "scratch" as const, templateLoaded: true, specError: null, fieldErrors: {}, nodeId: "n", name: "S", port: "" };
  it("paso 1: spec inválida, errores de campo o plantilla ausente bloquean y explican", () => {
    expect(stepBlock(1, ok)).toBeNull();
    expect(stepBlock(1, { ...ok, specError: "modpack.slugOrUrl: obligatorio" })).toBe("modpack.slugOrUrl: obligatorio");
    expect(stepBlock(1, { ...ok, fieldErrors: { "sf-memory": "x" } })).toMatch(/1 campo con error/);
    expect(stepBlock(1, { ...ok, fieldErrors: { a: "x", b: "y" } })).toMatch(/2 campos con error/);
    expect(stepBlock(1, { ...ok, source: "t1", templateLoaded: false })).toMatch(/plantilla/i);
    expect(stepBlock(1, { ...ok, source: "t1", templateLoaded: true, specError: "ignorado", fieldErrors: {} })).toBeNull();
  });
  it("paso 2: nodo, nombre y puerto", () => {
    expect(stepBlock(2, ok)).toBeNull();
    expect(stepBlock(2, { ...ok, nodeId: "" })).toMatch(/nodo/i);
    expect(stepBlock(2, { ...ok, name: "  " })).toMatch(/nombre/i);
    expect(stepBlock(2, { ...ok, port: "70000" })).toMatch(/puerto/i);
    expect(stepBlock(2, { ...ok, port: "abc" })).toMatch(/puerto/i);
    expect(stepBlock(2, { ...ok, port: "25570" })).toBeNull();
    expect(stepBlock(2, { ...ok, source: "t1", templateLoaded: false })).toMatch(/plantilla/i);
  });
});

describe("error de creación", () => {
  it("un 409 (slug o puerto en uso) vuelve al paso 2; el resto se queda en el 3", () => {
    expect(createErrorStep(409)).toBe(2);
    expect(createErrorStep(502)).toBe(3);
    expect(createErrorStep(undefined)).toBe(3);
  });
});
