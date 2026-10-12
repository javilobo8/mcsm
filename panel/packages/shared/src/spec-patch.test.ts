import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, formatZodError, mergeSpecPatch } from "./spec-patch.js";

describe("mergeSpecPatch", () => {
  const prev = { type: "PAPER", memory: "4G", mods: { modrinthProjects: ["a"] }, whitelist: { enabled: true, players: [] } };
  it("sustituye las claves presentes, conserva las ausentes y borra las null", () => {
    expect(mergeSpecPatch(prev, { memory: "6G", whitelist: null })).toEqual({ type: "PAPER", memory: "6G", mods: { modrinthProjects: ["a"] } });
  });
  it("no mezcla objetos anidados: la sección se sustituye entera", () => {
    expect(mergeSpecPatch(prev, { mods: { urls: ["https://x/a.jar"] } }).mods).toEqual({ urls: ["https://x/a.jar"] });
  });
  it("ignora __proto__ y constructor", () => {
    const patch = JSON.parse('{"__proto__":{"type":"FORGE"},"constructor":1}') as Record<string, unknown>;
    const out = mergeSpecPatch(prev, patch);
    expect(out.type).toBe("PAPER");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
  it("no modifica el objeto anterior", () => {
    mergeSpecPatch(prev, { memory: "1G" });
    expect(prev.memory).toBe("4G");
  });
});

describe("canonicalJson", () => {
  it("no depende del orden de las claves pero sí del de los arrays", () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }));
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
  });
});

describe("formatZodError", () => {
  it("antepone la ruta", () => {
    const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toMatch(/^a\.b: /);
  });
});

describe("mergeSpecPatch: secciones opcionales", () => {
  const prev = { type: "PAPER", ops: [], whitelist: { enabled: true, players: ["a"] } };
  it("ausente no toca, null elimina y [] deja la sección presente y vacía", () => {
    expect(mergeSpecPatch(prev, {})).toEqual(prev);
    const removed = mergeSpecPatch(prev, { ops: null });
    expect(removed).not.toHaveProperty("ops");
    expect(mergeSpecPatch(prev, { whitelist: { enabled: true, players: [] } }).whitelist).toEqual({ enabled: true, players: [] });
    expect(mergeSpecPatch({ type: "PAPER" }, { ops: [] })).toHaveProperty("ops", []);
  });
});
