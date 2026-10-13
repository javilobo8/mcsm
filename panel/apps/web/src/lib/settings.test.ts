import { describe, expect, it } from "vitest";
import type { SettingsDto } from "@mcsm/shared";
import { parsePortRange, parsePublicUrl, passwordFormError, portRangeForm, publicUrlNote, settingsLeaveWarning } from "./settings";

const dto = (over: Partial<SettingsDto> = {}): SettingsDto => ({
  publicUrl: "", publicUrlSource: "request", envPublicUrl: "", gamePortRange: { from: 25565, to: 25600 },
  defaultGamePortRange: { from: 25565, to: 25600 }, curseforge: { configured: false, valid: true }, ...over,
});

describe("ajustes en la web", () => {
  it("contraseña: actual obligatoria, mínimo 8 y repetida igual", () => {
    expect(passwordFormError({ current: "", next: "nueva-larga", repeat: "nueva-larga" })).toMatch(/actual/);
    expect(passwordFormError({ current: "x", next: "corta", repeat: "corta" })).toMatch(/8/);
    expect(passwordFormError({ current: "x", next: "nueva-larga", repeat: "otra-larga" })).toMatch(/no coinciden/);
    expect(passwordFormError({ current: "x", next: "nueva-larga", repeat: "nueva-larga" })).toBeNull();
  });

  it("rango de puertos desde el formulario", () => {
    expect(portRangeForm({ from: 26600, to: 26620 })).toEqual({ from: "26600", to: "26620" });
    expect(parsePortRange({ from: " 26600", to: "26620 " })).toEqual({ ok: true, value: { from: 26600, to: 26620 } });
    for (const bad of [{ from: "", to: "1" }, { from: "a", to: "2000" }, { from: "30000", to: "29000" }, { from: "80", to: "90" }]) {
      expect(parsePortRange(bad).ok).toBe(false);
    }
  });

  it("URL pública", () => {
    expect(parsePublicUrl("http://192.168.1.10:8080/")).toEqual({ ok: true, value: "http://192.168.1.10:8080" });
    expect(parsePublicUrl("")).toEqual({ ok: true, value: "" });
    expect(parsePublicUrl("http://x/ruta").ok).toBe(false);
  });

  it("de dónde sale la URL que se usa", () => {
    expect(publicUrlNote(dto())).toMatch(/dirección con la que abres el panel/);
    expect(publicUrlNote(dto({ publicUrl: "http://env:8080", publicUrlSource: "env", envPublicUrl: "http://env:8080" }))).toMatch(/PANEL_PUBLIC_URL/);
    expect(publicUrlNote(dto({ publicUrl: "http://a:8080", publicUrlSource: "settings" }))).toMatch(/Guardada aquí/);
  });

  it("aviso al salir con cambios", () => {
    expect(settingsLeaveWarning(false)).toBeNull();
    expect(settingsLeaveWarning(true)?.title).toBe("Ajustes sin guardar");
  });
});
