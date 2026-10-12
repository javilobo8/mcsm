import { describe, expect, it } from "vitest";
import { decideTabChange, tabGuardText } from "./tab-guard";

describe("decideTabChange", () => {
  it("confirma solo si hay cambios sin guardar y se cambia de pestaña", () => {
    expect(decideTabChange(true, "files", "console")).toBe("confirm");
    expect(decideTabChange(true, "files", "files")).toBe("switch");
    expect(decideTabChange(false, "files", "console")).toBe("switch");
  });
});

describe("tabGuardText", () => {
  it("sin texto propio, el genérico de cambios sin guardar", () => {
    expect(tabGuardText(null)).toEqual({ title: "Cambios sin guardar", description: "Hay cambios sin guardar en esta pestaña. Si cambias de pestaña se perderán.", confirmLabel: "Descartar y cambiar" });
  });
  it("con texto propio (p. ej. una subida en curso), ese", () => {
    const w = { title: "Subida en curso", description: "Hay una subida en curso. Si sales, se cancelará la subida.", confirmLabel: "Salir y cancelar la subida" };
    expect(tabGuardText(w)).toEqual(w);
  });
});
