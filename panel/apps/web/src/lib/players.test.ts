import { describe, expect, it } from "vitest";
import { offlineModeWarning } from "./players";

describe("offline mode", () => {
  it("warns with online-mode=false and operators or whitelist by name", () => {
    expect(offlineModeWarning({ properties: { "online-mode": "false" }, ops: ["Lobo"] })).toMatch(/anyone can join/);
    expect(offlineModeWarning({ properties: { "online-mode": "false" }, whitelist: { players: ["Steve"] } })).not.toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": "false" } })).toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": "true" }, ops: ["Lobo"] })).toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": "False" }, ops: ["Lobo"] })).not.toBeNull();
    expect(offlineModeWarning({ properties: { "online-mode": " FALSE " }, ops: ["Lobo"] })).not.toBeNull();
    expect(offlineModeWarning({ env: { ONLINE_MODE: "false" }, ops: ["Lobo"] })).not.toBeNull(); // the itzg variable
    expect(offlineModeWarning({ env: { ONLINE_MODE: "TRUE" }, ops: ["Lobo"] })).toBeNull();
    expect(offlineModeWarning({ ops: ["Lobo"] })).toBeNull();
  });
});
