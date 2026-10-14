import { describe, expect, it } from "vitest";
import { hash01 } from "./noise";

describe("hash01", () => {
  it("is deterministic and within [0, 1)", () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3));
    expect(hash01(1, 2, 3)).not.toBe(hash01(3, 2, 1));
    for (let i = 0; i < 50; i++) {
      const v = hash01(i, i * 7, -i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("gives the same values as the website's (the login's sky and ground look the same)", () => {
    expect(hash01(0, 0, 7)).toBeCloseTo(0.227536, 6);
  });
});
