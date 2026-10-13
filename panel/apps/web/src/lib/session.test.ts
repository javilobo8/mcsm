import { describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage } from "./api";
import { createUnauthorizedGate, createUnauthorizedHandler, isSessionExpired, loginRedirectFor, resolveHeld401, safeRedirect, shouldRetry } from "./session";
import { formatBytes, stateLabel } from "./format";

describe("401 global", () => {
  it("only counts 401 outside /api/auth/", () => {
    expect(isSessionExpired(401, "/api/servers")).toBe(true);
    expect(isSessionExpired(401, "/api/auth/login")).toBe(false);
    expect(isSessionExpired(403, "/api/servers")).toBe(false);
  });
  it("does not retry 4xx and retries the rest once", () => {
    expect(shouldRetry(0, new ApiError(401, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiError(500, "x"))).toBe(true);
    expect(shouldRetry(1, new ApiError(500, "x"))).toBe(false);
    expect(shouldRetry(0, new Error("red"))).toBe(true);
  });
  it("keeps the destination and avoids open redirects", () => {
    expect(loginRedirectFor("/servers/abc?tab=logs")).toBe("/servers/abc?tab=logs");
    expect(loginRedirectFor("/")).toBeUndefined();
    expect(loginRedirectFor("/login?redirect=%2Fnodes")).toBeUndefined();
    expect(safeRedirect("/nodes")).toBe("/nodes");
    expect(safeRedirect("//evil.com")).toBe("/");
    expect(safeRedirect("https://evil.com")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });
  it("the handler navigates only once and does not act on /login", () => {
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

describe("error messages", () => {
  it("uses the body, and if there is none, messages in English", () => {
    expect(errorMessage(400, "Bad", { error: "Invalid data" })).toBe("Invalid data");
    expect(errorMessage(502, "", null)).toContain("The panel is not responding");
    expect(errorMessage(404, "", null)).toBe("Error HTTP 404");
  });
});

describe("format", () => {
  it("robust formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(0.5)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
  it("stateLabel: running without health is Running", () => {
    const o = (health: string) => ({ state: "running", health, error: "" });
    expect(stateLabel(o(""), "running").text).toBe("Running");
    expect(stateLabel(o("starting"), "running").text).toBe("Starting");
    expect(stateLabel(o("healthy"), "running").text).toBe("Running");
  });
});

describe("REST 401 during a session change", () => {
  it("pure decision when releasing the hold", () => {
    expect(resolveHeld401(false, true)).toBe("none");
    expect(resolveHeld401(false, false)).toBe("none");
    expect(resolveHeld401(true, true)).toBe("invalidate");
    expect(resolveHeld401(true, false)).toBe("unauthorized");
  });

  it("without a hold the 401 is notified immediately", () => {
    const fire = vi.fn();
    createUnauthorizedGate(fire).report();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("with a hold it is not notified; on success it asks to invalidate and on failure it notifies", () => {
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
    gate.report(); // now without a hold
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("overlapping holds decide when the last one is released", () => {
    const fire = vi.fn();
    const gate = createUnauthorizedGate(fire);
    const a = gate.hold(); const b = gate.hold();
    gate.report();
    expect(a(false)).toBe("none");
    expect(b(true)).toBe("invalidate");
    expect(a(true)).toBe("none"); // releasing twice does not count
    expect(fire).not.toHaveBeenCalled();
  });
});
