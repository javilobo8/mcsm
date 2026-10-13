import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Injection point: after verifying, the first armed call waits for `gate.release`.
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

describe("login in progress during a password change", () => {
  it("leaves no session: the hash changed while it was being verified", async () => {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const c = setup.cookies.find((c) => c.name === "mcsm_session")!;
    const mine = `${c.name}=${c.value}`;

    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    gate.armed = { entered, wait: new Promise<void>((r) => { release = r; }) };
    const login = app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
    await inside; // the login already accepted the old password and is stopped before creating the session

    const change = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, payload: { currentPassword: "correct horse", newPassword: "nueva-larga" } });
    expect(change.statusCode).toBe(200);
    release();
    const res = await login;
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "mcsm_session")).toBeUndefined();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 }); // only the one of whoever changed the password
  });
});
