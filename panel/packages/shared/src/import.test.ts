import { describe, expect, it } from "vitest";
import { importAdoptSchema, sameSpecInput } from "./import.js";
import { defaultSpecInput } from "./spec.js";

const ID = "a".repeat(64);

describe("importAdoptSchema", () => {
  it("acepta la petición y pone applyNow=false por defecto", () => {
    const r = importAdoptSchema.parse({ containerId: ID, name: " Survival ", spec: { type: "PAPER" } });
    expect(r).toEqual({ containerId: ID, name: "Survival", spec: { type: "PAPER" }, applyNow: false });
  });
  it("rechaza ids que no son de Docker y slugs inválidos", () => {
    expect(importAdoptSchema.safeParse({ containerId: "abc", name: "x", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "x", slug: "Mal", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "", spec: {} }).success).toBe(false);
  });
});

describe("sameSpecInput", () => {
  it("compara tras normalizar con zod", () => {
    expect(sameSpecInput({}, defaultSpecInput())).toBe(true);
    expect(sameSpecInput({ memory: "4G" }, { ...defaultSpecInput(), memory: "4G" })).toBe(true);
  });
  it("ignora dataPath y rconPassword (no los edita el usuario)", () => {
    expect(sameSpecInput({ dataPath: "/home/lobo/mc", rconPassword: "x".repeat(10) }, {})).toBe(true);
  });
  it("detecta un cambio real", () => {
    expect(sameSpecInput({ memory: "4G" }, { memory: "6G" })).toBe(false);
    expect(sameSpecInput({ env: { A: "1" } }, { env: { A: "2" } })).toBe(false);
  });
});
