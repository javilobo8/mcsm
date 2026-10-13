import { describe, expect, it } from "vitest";
import { MAX_CLOCK_SKEW_SECONDS } from "@mcsm/shared";
import { agentIso } from "./time.js";

describe("agentIso", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const day = 86_400_000;

  it("acepta una hora razonable y la devuelve en ISO", () => {
    expect(agentIso(BigInt(now - 1000), now)).toBe(new Date(now - 1000).toISOString());
  });

  it("rechaza cero, el futuro más allá del desfase tolerado y lo más viejo que 30 días", () => {
    expect(agentIso(0n, now)).toBeNull();
    expect(agentIso(BigInt(now + MAX_CLOCK_SKEW_SECONDS * 1000 + 1), now)).toBeNull();
    expect(agentIso(BigInt(now + MAX_CLOCK_SKEW_SECONDS * 1000), now)).not.toBeNull();
    expect(agentIso(BigInt(now - 30 * day - 1), now)).toBeNull();
  });
});
