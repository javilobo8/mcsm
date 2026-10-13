import { describe, expect, it } from "vitest";
import { isPanelOrigin, passwordChangeSchema, portRangeSchema, publicUrlSchema, settingsPutSchema } from "./settings.js";

describe("ajustes", () => {
  it("public URL: an http(s) origin without a path, normalized", () => {
    expect(publicUrlSchema.parse("http://192.168.1.10:8080/")).toBe("http://192.168.1.10:8080");
    expect(publicUrlSchema.parse("  HTTP://Panel.Lan:8080  ")).toBe("http://panel.lan:8080");
    expect(publicUrlSchema.parse("")).toBe("");
    for (const bad of ["ftp://x", "http://x/path", "http://x?a=1", "http://u:p@x", "panel:8080", "http://x#y"]) {
      expect(isPanelOrigin(bad)).toBe(false);
      expect(publicUrlSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("port range", () => {
    expect(portRangeSchema.parse({ from: 26600, to: 26620 })).toEqual({ from: 26600, to: 26620 });
    for (const bad of [{ from: 80, to: 90 }, { from: 30000, to: 29999 }, { from: 20000, to: 30001 }, { from: 1024.5, to: 2000 }, { from: 2000, to: 70000 }]) {
      expect(portRangeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("strict PUT and password change", () => {
    expect(settingsPutSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(settingsPutSchema.parse({ publicUrl: "" })).toEqual({ publicUrl: "" });
    expect(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "corta" }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ currentPassword: "", newPassword: "larga-suficiente" }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "larga-suficiente" }).success).toBe(true);
  });
});
