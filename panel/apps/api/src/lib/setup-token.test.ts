import { describe, expect, it } from "vitest";
import { resolveSetupToken } from "./setup-token.js";

describe("PANEL_SETUP_TOKEN", () => {
  it("se recorta; vacío o ausente genera uno aleatorio", () => {
    expect(resolveSetupToken("  mi-token \n", () => "gen")).toEqual({ token: "mi-token", fromEnv: true });
    expect(resolveSetupToken(undefined, () => "gen")).toEqual({ token: "gen", fromEnv: false });
    expect(resolveSetupToken("   ", () => "gen")).toEqual({ token: "gen", fromEnv: false });
  });

  it("más de 200 caracteres es un error de arranque claro (no podría coincidir nunca)", () => {
    expect(() => resolveSetupToken("x".repeat(201), () => "gen")).toThrow(/PANEL_SETUP_TOKEN.*200/);
    expect(resolveSetupToken("x".repeat(200), () => "gen").token).toHaveLength(200);
  });
});
