import { describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage } from "./api";
import { createUnauthorizedGate, createUnauthorizedHandler, isSessionExpired, loginRedirectFor, resolveHeld401, safeRedirect, shouldRetry } from "./session";
import { formatBytes, stateLabel } from "./format";

describe("401 global", () => {
  it("solo cuenta 401 fuera de /api/auth/", () => {
    expect(isSessionExpired(401, "/api/servers")).toBe(true);
    expect(isSessionExpired(401, "/api/auth/login")).toBe(false);
    expect(isSessionExpired(403, "/api/servers")).toBe(false);
  });
  it("no reintenta 4xx y reintenta una vez el resto", () => {
    expect(shouldRetry(0, new ApiError(401, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, "x"))).toBe(true);
    expect(shouldRetry(1, new ApiError(500, "x"))).toBe(false);
    expect(shouldRetry(0, new Error("red"))).toBe(true);
  });
  it("conserva el destino y evita redirecciones abiertas", () => {
    expect(loginRedirectFor("/servers/abc?tab=logs")).toBe("/servers/abc?tab=logs");
    expect(loginRedirectFor("/")).toBeUndefined();
    expect(loginRedirectFor("/login?redirect=%2Fnodes")).toBeUndefined();
    expect(safeRedirect("/nodes")).toBe("/nodes");
    expect(safeRedirect("//evil.com")).toBe("/");
    expect(safeRedirect("https://evil.com")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });
  it("el handler navega una sola vez y no actúa en /login", () => {
    const goToLogin = vi.fn(); const clearCache = vi.fn();
    let loc = "/nodes";
    const h = createUnauthorizedHandler({ clearCache, goToLogin, currentLocation: () => loc });
    h(); h(); h();
    expect(goToLogin).toHaveBeenCalledTimes(1);
    expect(goToLogin).toHaveBeenCalledWith("/nodes");
    expect(clearCache).toHaveBeenCalledTimes(1);
    loc = "/login"; h.reset(); h();
    expect(goToLogin).toHaveBeenCalledTimes(1);
  });
});

describe("mensajes de error", () => {
  it("usa el cuerpo, y si no hay, mensajes en castellano", () => {
    expect(errorMessage(400, "Bad", { error: "Datos inválidos" })).toBe("Datos inválidos");
    expect(errorMessage(502, "", null)).toContain("El panel no responde");
    expect(errorMessage(404, "", null)).toBe("Error HTTP 404");
  });
});

describe("format", () => {
  it("formatBytes robusto", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(0.5)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
  it("stateLabel: running sin health es En marcha", () => {
    const o = (health: string) => ({ state: "running", health, error: "" });
    expect(stateLabel(o(""), "running").text).toBe("En marcha");
    expect(stateLabel(o("starting"), "running").text).toBe("Arrancando");
    expect(stateLabel(o("healthy"), "running").text).toBe("En marcha");
  });
});

describe("401 REST durante un cambio de sesión", () => {
  it("decisión pura al soltar la retención", () => {
    expect(resolveHeld401(false, true)).toBe("none");
    expect(resolveHeld401(false, false)).toBe("none");
    expect(resolveHeld401(true, true)).toBe("invalidate");
    expect(resolveHeld401(true, false)).toBe("unauthorized");
  });

  it("sin retención el 401 se notifica al momento", () => {
    const fire = vi.fn();
    createUnauthorizedGate(fire).report();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("con retención no se notifica; con éxito pide invalidar y con fallo notifica", () => {
    const fire = vi.fn();
    const gate = createUnauthorizedGate(fire);
    const release = gate.hold();
    gate.report();
    expect(fire).not.toHaveBeenCalled();
    expect(release(true)).toBe("invalidate");
    expect(fire).not.toHaveBeenCalled();

    const release2 = gate.hold();
    gate.report();
    expect(release2(false)).toBe("unauthorized");
    expect(fire).toHaveBeenCalledTimes(1);
    gate.report(); // ya sin retención
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("retenciones solapadas deciden al soltar la última", () => {
    const fire = vi.fn();
    const gate = createUnauthorizedGate(fire);
    const a = gate.hold(); const b = gate.hold();
    gate.report();
    expect(a(false)).toBe("none");
    expect(b(true)).toBe("invalidate");
    expect(a(true)).toBe("none"); // soltar dos veces no cuenta
    expect(fire).not.toHaveBeenCalled();
  });
});
