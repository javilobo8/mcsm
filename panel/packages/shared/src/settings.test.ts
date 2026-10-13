import { describe, expect, it } from "vitest";
import { connectAddressSchema, isPanelOrigin, passwordChangeSchema, portRangeSchema, publicUrlSchema, settingsPutSchema } from "./settings.js";

describe("settings", () => {
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

  it("connection address: domain or IPv4 (normalized), external port or null", () => {
    expect(connectAddressSchema.parse({ host: "  MC.Example.com ", port: 55567 })).toEqual({ host: "mc.example.com", port: 55567 });
    expect(connectAddressSchema.parse({ host: "203.0.113.7", port: null })).toEqual({ host: "203.0.113.7", port: null });
    expect(connectAddressSchema.parse({ host: "", port: null })).toEqual({ host: "", port: null });
    for (const bad of [{ host: "mc.example.com:55567", port: null }, { host: "http://mc.example.com", port: null }, { host: "a b", port: null },
      { host: "x", port: 0 }, { host: "x", port: 65536 }, { host: "x", port: 1.5 }, { host: "x" }]) {
      expect(connectAddressSchema.safeParse(bad).success).toBe(false);
    }
    expect(settingsPutSchema.parse({ connectAddress: { host: "mc.example.com", port: 55567 } })).toEqual({ connectAddress: { host: "mc.example.com", port: 55567 } });
  });

  it("strict PUT and password change", () => {
    expect(settingsPutSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(settingsPutSchema.parse({ publicUrl: "" })).toEqual({ publicUrl: "" });
    expect(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "short" }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ currentPassword: "", newPassword: "long-enough-pw" }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ currentPassword: "x", newPassword: "long-enough-pw" }).success).toBe(true);
  });
});
