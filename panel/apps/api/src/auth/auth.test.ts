import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  app.get("/api/__probe", async () => ({ ok: true }));
  app.get("/ws", async () => ({ ok: true }));
  await app.ready();
});
afterEach(async () => { await app.close(); });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((c) => c.name === "mcsm_session");
  return c ? `${c.name}=${c.value}` : "";
};

describe("auth", () => {
  it("sin contraseña configurada, status lo indica y setup crea sesión", async () => {
    let res = await app.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.json()).toEqual({ configured: false, authenticated: false });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^mcsm_session=/);
    res = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true, authenticated: true });
    res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "otra" } });
    expect(res.statusCode).toBe(409);
  });

  it("login correcto e incorrecto, logout y rutas protegidas", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    let res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "POST", url: "/api/auth/logout" }); // protegida y ya existente en esta task
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

  it("rechaza contraseñas cortas en setup", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "1234" } });
    expect(res.statusCode).toBe(400);
  });

  it("protege la ruta enrutada aunque la URL venga codificada", async () => {
    for (const url of ["/api/__probe", "/%61pi/__probe", "/%77s"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/%61pi/__probe", headers: { cookie } })).statusCode).toBe(200);
  });

  it("sesión expirada devuelve 401", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    app.db.prepare("UPDATE sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie } })).statusCode).toBe(401);
  });

  it("cookie con firma manipulada devuelve 401", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const real = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse" } }));
    const last = real.slice(-1);
    const forged = real.slice(0, -1) + (last === "A" ? "B" : "A");
    expect((await app.inject({ method: "GET", url: "/api/__probe", headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("setup concurrente: solo uno gana y la contraseña válida es la del ganador", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "password-uno" } }),
      app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "password-dos" } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const [winner, loser] = a.statusCode === 200 ? ["password-uno", "password-dos"] : ["password-dos", "password-uno"];
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: winner } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: loser } })).statusCode).toBe(401);
  });

  it("rate-limit: el login devuelve 429 tras superar el límite", async () => {
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "nope-nope" } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("rate-limit: el setup devuelve 429 tras superar el límite", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "1234" } })).statusCode);
    }
    expect(codes[10]).toBe(429);
  });
});
