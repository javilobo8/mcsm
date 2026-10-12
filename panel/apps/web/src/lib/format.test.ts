import { describe, expect, it } from "vitest";
import { canPower, displayState } from "./format";

const running = { state: "running", health: "healthy", error: "" };

describe("displayState", () => {
  it("muestra el último observed con el nodo conectado", () => {
    expect(displayState(running, "running", true)).toEqual({ text: "En marcha", tone: "ok" });
  });
  it("con el nodo desconectado oculta el observed obsoleto", () => {
    expect(displayState(running, "running", false)).toEqual({ text: "Nodo desconectado", tone: "muted" });
  });
  it("sin información del nodo (aún cargando) usa el observed", () => {
    expect(displayState(running, "running", undefined).text).toBe("En marcha");
  });
});

describe("canPower", () => {
  it("solo habilita acciones con el nodo conectado", () => {
    expect(canPower(true)).toBe(true);
    expect(canPower(false)).toBe(false);
    expect(canPower(undefined)).toBe(true);
  });
});
