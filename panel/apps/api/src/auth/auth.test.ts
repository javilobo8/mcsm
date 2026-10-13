import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  app.get("/api/__probe", async () => ({ ok: true }));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((c) => c.name === "mcsm_session");
  return c ? `${c.name}=${c.value}` : "";
};

describe("auth", () => {
  it("with no password configured, status says so and setup creates a session", async () => {
    let res = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.json()).toEqual({ configured: false, authenticated: false, setupTokenRequired: false });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^mcsm_session=/);
    res = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true, authenticated: true, setupTokenRequired: false });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "other" } });
    expect(res.statusCode).toBe(409);
  });

  it("correct and incorrect login, logout and protected routes", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    let res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "POST", url: "/api/auth/logout" }); // protected and already existing in this task
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    res = await app.inject({ method: "GET", url: "/api/health", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json().authenticated).toBe(false);
  });

  it("rejects short passwords on setup", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "1234" } });
    expect(res.statusCode).toBe(400);
  });

  it("protects the routed route even if the URL comes encoded", async () => {
    for (const url of ["/api/__probe", "/%61pi/__probe", "/%77s"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/%61pi/__probe", headers: { cookie } })).statusCode).toBe(200);
  });

  it("an expired session returns 401", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    app.db.prepare("UPDATE sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie } })).statusCode).toBe(401);
  });

  it("a cookie with a tampered signature returns 401", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const real = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    const last = real.slice(-1);
    const forged = real.slice(0, -1) + (last === "A" ? "B" : "A");
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("concurrent setup: only one wins and the valid password is the winner's", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "password-one" } }),
      app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "password-two" } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const [winner, loser] = a.statusCode === 200 ? ["password-one", "password-two"] : ["password-two", "password-one"];
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: winner } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: loser } })).statusCode).toBe(401);
  });

  it("rate-limit: login returns 429 after exceeding the limit", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope-nope" } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("rate-limit: setup returns 429 after exceeding the limit", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "1234" } })).statusCode);
    }
    expect(codes[10]).toBe(429);
  });
});

describe("initial setup token (L3)", () => {
  it("with a token, setup requires it; afterwards it is no longer asked for", async () => {
    const a = await buildApp({ db: openDb(":memory:"), config: { setupToken: "tok-inicial" } });
    expect((await a.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ configured: false, authenticated: false, setupTokenRequired: true });
    for (const setupToken of [undefined, "other"]) {
      const r = await a.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse", setupToken } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/panel log/);
    }
    expect((await a.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse", setupToken: "tok-inicial" } })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ configured: true, setupTokenRequired: false });
    await a.close();
  });
});

describe("password change", () => {
  it("requires the current one and closes all sessions, giving a new one to whoever changes it", async () => {
    let res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const mine = cookieOf(res);
    res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } });
    const other = cookieOf(res);
    const change = (cookie: string, payload: object) => app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie }, payload });
    expect((await app.inject({ method: "POST", url: "/api/auth/password", payload: { currentPassword: "x", newPassword: "nueva-larga" } })).statusCode).toBe(401);
    res = await change(mine, { currentPassword: "mal", newPassword: "nueva-larga" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/current password is not correct/);
    expect((await change(mine, { currentPassword: "correct horse", newPassword: "corta" })).statusCode).toBe(400);
    res = await change(mine, { currentPassword: "correct horse", newPassword: "nueva-larga" });
    expect(res.json()).toEqual({ ok: true });
    const fresh = cookieOf(res); // new cookie for whoever changed the password
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(mine);
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie: fresh } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie: mine } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie: other } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nueva-larga" } })).statusCode).toBe(200);
  });
});

describe("current password failures", () => {
  it("count towards the global failure limit, including the login one", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const mine = cookieOf(res);
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, remoteAddress: `10.1.${i}.1`, payload: { currentPassword: "mal", newPassword: "nueva-larga" } });
      expect(r.statusCode).toBe(400);
    }
    const blocked = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie: mine }, remoteAddress: "10.9.9.9", payload: { currentPassword: "correct horse", newPassword: "nueva-larga" } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many failed attempts/);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.9.9.8", payload: { password: "correct horse" } });
    expect(login.statusCode).toBe(429);
  });
});
