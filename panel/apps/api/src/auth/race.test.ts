import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Punto de inyección: tras verificar, la primera llamada armada espera a `gate.release`.
const gate = vi.hoisted(() => ({ armed: null as null | { entered: () => void; wait: Promise<void> } }));
vi.mock("./password.js", async (orig) => {
  const m = await orig<typeof import("./password.js")>();
  return {
    ...m,
    verifyPassword: async (...a: Parameters<typeof m.verifyPassword>) => {
      const ok = await m.verifyPassword(...a);
      const armed = gate.armed;
      gate.armed = null;
      if (armed) { armed.entered(); await armed.wait; }
      return ok;
    },
  };
});

import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
beforeEach(async () => { app = await buildApp({ db: openDb(":memory:") }); });
afterEach(async () => { await app.close(); });

describe("login en curso durante un cambio de contraseña", () => {
  it("no deja sesión: el hash cambió mientras se verificaba", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const c = setup.cookies.find((c) => c.name === "mcsm_session")!;
    const mine = `${c.name}=${c.value}`;

    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    gate.armed = { entered, wait: new Promise<void>((r) => { release = r; }) };
    const login = app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
    await inside; // el login ya aceptó la contraseña vieja y está parado antes de crear la sesión

    const change = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, payload: { currentPassword: "correct horse", newPassword: "nueva-larga" } });
    expect(change.statusCode).toBe(200);
    release();
    const res = await login;
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "mcsm_session")).toBeUndefined();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 }); // solo la de quien cambió la contraseña
  });
});
