import { describe, expect, it } from "vitest";
import { importAdoptSchema, sameSpecInput } from "./import.js";
import { defaultSpecInput } from "./spec.js";

const ID = "a".repeat(64);

describe("importAdoptSchema", () => {
  it("accepts the request and sets applyNow=false by default", () => {
    const r = importAdoptSchema.parse({ containerId: ID, name: " Survival ", spec: { type: "PAPER" } });
    expect(r).toEqual({ containerId: ID, name: "Survival", spec: { type: "PAPER" }, applyNow: false });
  });
  it("rejects ids that are not Docker's and invalid slugs", () => {
    expect(importAdoptSchema.safeParse({ containerId: "abc", name: "x", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "x", slug: "Mal", spec: {} }).success).toBe(false);
    expect(importAdoptSchema.safeParse({ containerId: ID, name: "", spec: {} }).success).toBe(false);
  });
});

describe("sameSpecInput", () => {
  it("compares after normalizing with zod", () => {
    expect(sameSpecInput({}, defaultSpecInput())).toBe(true);
    expect(sameSpecInput({ memory: "4G" }, { ...defaultSpecInput(), memory: "4G" })).toBe(true);
  });
  it("ignores dataPath and rconPassword (the user does not edit them)", () => {
    expect(sameSpecInput({ dataPath: "/home/lobo/mc", rconPassword: "x".repeat(10) }, {})).toBe(true);
  });
  it("detects a real change", () => {
    expect(sameSpecInput({ memory: "4G" }, { memory: "6G" })).toBe(false);
    expect(sameSpecInput({ env: { A: "1" } }, { env: { A: "2" } })).toBe(false);
  });
});
