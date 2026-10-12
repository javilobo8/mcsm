import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance;
beforeEach(async () => { app = await buildApp({ db: openDb(":memory:") }); await app.ready(); });
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
});
