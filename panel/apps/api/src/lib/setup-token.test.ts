import { describe, expect, it } from "vitest";
import { resolveSetupToken } from "./setup-token.js";

describe("PANEL_SETUP_TOKEN", () => {
  it("is trimmed; empty or absent generates a random one", () => {
    expect(resolveSetupToken("  mi-token \n", () => "gen")).toEqual({ token: "mi-token", fromEnv: true });
    expect(resolveSetupToken(undefined, () => "gen")).toEqual({ token: "gen", fromEnv: false });
    expect(resolveSetupToken("   ", () => "gen")).toEqual({ token: "gen", fromEnv: false });
  });

  it("more than 200 characters is a clear startup error (it could never match)", () => {
    expect(() => resolveSetupToken("x".repeat(201), () => "gen")).toThrow(/PANEL_SETUP_TOKEN.*200/);
    expect(resolveSetupToken("x".repeat(200), () => "gen").token).toHaveLength(200);
  });
});
