import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, formatZodError, mergeSpecPatch } from "./spec-patch.js";

describe("mergeSpecPatch", () => {
  const prev = { type: "PAPER", memory: "4G", mods: { modrinthProjects: ["a"] }, whitelist: { enabled: true, players: [] } };
  it("replaces the present keys, keeps the absent ones and deletes the null ones", () => {
    expect(mergeSpecPatch(prev, { memory: "6G", whitelist: null })).toEqual({ type: "PAPER", memory: "6G", mods: { modrinthProjects: ["a"] } });
  });
  it("does not merge nested objects: the section is replaced whole", () => {
    expect(mergeSpecPatch(prev, { mods: { urls: ["https://x/a.jar"] } }).mods).toEqual({ urls: ["https://x/a.jar"] });
  });
  it("ignora __proto__ y constructor", () => {
    const patch = JSON.parse('{"__proto__":{"type":"FORGE"},"constructor":1}') as Record<string, unknown>;
    const out = mergeSpecPatch(prev, patch);
    expect(out.type).toBe("PAPER");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
  it("does not modify the previous object", () => {
    mergeSpecPatch(prev, { memory: "1G" });
    expect(prev.memory).toBe("4G");
  });
});

describe("canonicalJson", () => {
  it("does not depend on key order but does on array order", () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }));
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
  });
});

describe("formatZodError", () => {
  it("prepends the path", () => {
    const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toMatch(/^a\.b: /);
  });
});

describe("mergeSpecPatch: secciones opcionales", () => {
  const prev = { type: "PAPER", ops: [], whitelist: { enabled: true, players: ["a"] } };
  it("absent does not touch, null removes and [] leaves the section present and empty", () => {
    expect(mergeSpecPatch(prev, {})).toEqual(prev);
    const removed = mergeSpecPatch(prev, { ops: null });
    expect(removed).not.toHaveProperty("ops");
    expect(mergeSpecPatch(prev, { whitelist: { enabled: true, players: [] } }).whitelist).toEqual({ enabled: true, players: [] });
    expect(mergeSpecPatch({ type: "PAPER" }, { ops: [] })).toHaveProperty("ops", []);
  });
});

describe("specPatchNullError: null only on optional sections", () => {
  it("rejects null on keys with a default value or required ones; allows optional and unknown ones", async () => {
    const { specPatchNullError } = await import("./spec.js");
    for (const k of ["type", "version", "memory", "ports", "imageTag", "properties", "env", "resources", "restartPolicy"]) {
      expect(specPatchNullError({ [k]: null }), k).toMatch(new RegExp(k));
    }
    for (const k of ["modpack", "mods", "plugins", "whitelist", "ops", "desconocida"]) expect(specPatchNullError({ [k]: null }), k).toBeNull();
    expect(specPatchNullError({ type: "FABRIC", memory: "4G" })).toBeNull();
    expect(specPatchNullError({})).toBeNull();
  });
});
