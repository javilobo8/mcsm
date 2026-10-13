import { describe, expect, it } from "vitest";
import { offlineModeWarning } from "./players";

describe("modo offline", () => {
  it("avisa con online-mode=false y operadores o whitelist por nombre", () => {
    expect(offlineModeWarning({ properties: { "online-mode": "false" }, ops: ["Lobo"] })).toMatch(/cualquiera puede entrar/);
    expect(offlineModeWarning({ properties: { "online-mode": "false" }, whitelist: { players: ["Steve"] } })).not.toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": "false" } })).toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": "true" }, ops: ["Lobo"] })).toBeNull();
    expect(offlineModeWarning({ ops: ["Lobo"] })).toBeNull();
  });
});
