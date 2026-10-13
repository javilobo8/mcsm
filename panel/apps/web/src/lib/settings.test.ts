import { describe, expect, it } from "vitest";
import type { SettingsDto } from "@mcsm/shared";
import { connectForm, parseConnectAddress, parsePortRange, parsePublicUrl, passwordFormError, portRangeForm, publicUrlNote, settingsLeaveWarning } from "./settings";

const dto = (over: Partial<SettingsDto> = {}): SettingsDto => ({
  publicUrl: "", publicUrlSource: "request", envPublicUrl: "", gamePortRange: { from: 25565, to: 25600 },
  defaultGamePortRange: { from: 25565, to: 25600 }, connectAddress: { host: "", port: null }, curseforge: { configured: false, valid: true }, ...over,
});

describe("settings in the web", () => {
  it("connection address: form ↔ value; empty port = each server's own", () => {
    expect(connectForm({ host: "mc.example.com", port: 55567 })).toEqual({ host: "mc.example.com", port: "55567" });
    expect(connectForm({ host: "", port: null })).toEqual({ host: "", port: "" });
    expect(parseConnectAddress({ host: " MC.example.com ", port: " 55567 " })).toEqual({ ok: true, value: { host: "mc.example.com", port: 55567 } });
    expect(parseConnectAddress({ host: "mc.example.com", port: "" })).toEqual({ ok: true, value: { host: "mc.example.com", port: null } });
    expect(parseConnectAddress({ host: "mc.example.com", port: "abc" })).toMatchObject({ ok: false, error: expect.stringMatching(/port/) });
    expect(parseConnectAddress({ host: "mc.example.com:55567", port: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/address/) });
    expect(parseConnectAddress({ host: "mc.example.com", port: "70000" })).toMatchObject({ ok: false, error: expect.stringMatching(/65535/) });
  });

  it("password: current required, minimum 8 and repeated the same", () => {
    expect(passwordFormError({ current: "", next: "new-long", repeat: "new-long" })).toMatch(/current/);
    expect(passwordFormError({ current: "x", next: "short", repeat: "short" })).toMatch(/8/);
    expect(passwordFormError({ current: "x", next: "new-long", repeat: "other-long" })).toMatch(/do not match/);
    expect(passwordFormError({ current: "x", next: "new-long", repeat: "new-long" })).toBeNull();
  });

  it("port range from the form", () => {
    expect(portRangeForm({ from: 26600, to: 26620 })).toEqual({ from: "26600", to: "26620" });
    expect(parsePortRange({ from: " 26600", to: "26620 " })).toEqual({ ok: true, value: { from: 26600, to: 26620 } });
    for (const bad of [{ from: "", to: "1" }, { from: "a", to: "2000" }, { from: "30000", to: "29000" }, { from: "80", to: "90" }]) {
      expect(parsePortRange(bad).ok).toBe(false);
    }
  });

  it("public URL", () => {
    expect(parsePublicUrl("http://192.168.1.10:8080/")).toEqual({ ok: true, value: "http://192.168.1.10:8080" });
    expect(parsePublicUrl("")).toEqual({ ok: true, value: "" });
    expect(parsePublicUrl("http://x/path").ok).toBe(false);
  });

  it("where the URL in use comes from", () => {
    expect(publicUrlNote(dto())).toMatch(/address you use to open the panel/);
    expect(publicUrlNote(dto({ publicUrl: "http://env:8080", publicUrlSource: "env", envPublicUrl: "http://env:8080" }))).toMatch(/PANEL_PUBLIC_URL/);
    expect(publicUrlNote(dto({ publicUrl: "http://a:8080", publicUrlSource: "settings" }))).toMatch(/Saved here/);
  });

  it("warning when leaving with changes", () => {
    expect(settingsLeaveWarning(false)).toBeNull();
    expect(settingsLeaveWarning(true)?.title).toBe("Unsaved settings");
  });
});
