import { describe, expect, it } from "vitest";
import { decideTabChange } from "./tab-guard";

describe("decideTabChange", () => {
  it("confirma solo si hay cambios sin guardar y se cambia de pestaña", () => {
    expect(decideTabChange(true, "files", "console")).toBe("confirm");
    expect(decideTabChange(true, "files", "files")).toBe("switch");
    expect(decideTabChange(false, "files", "console")).toBe("switch");
  });
});
