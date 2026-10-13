import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string;
beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

const post = (origin?: string) => app.inject({
  method: "POST", url: "/api/nodes/enrollment-tokens", payload: { nameHint: "n" },
  headers: { cookie, host: "panel.lan:8080", ...(origin ? { origin } : {}) },
});

describe("Origin en peticiones que escriben", () => {
  it("un Origin ajeno es 403; sin Origin, el del propio host o el de la URL pública pasan", async () => {
    expect((await post("http://otra-web.lan:9000")).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(200); // curl, agente: no mandan Origin
    expect((await post("http://panel.lan:8080")).statusCode).toBe(200);
    app.settings.update({ publicUrl: "http://publica.lan:8080" });
    expect((await post("http://publica.lan:8080")).statusCode).toBe(200);
  });

  it("las lecturas no se comprueban y /agent/* queda fuera", async () => {
    const get = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie, origin: "http://otra-web.lan:9000" } });
    expect(get.statusCode).toBe(200);
    const enroll = await app.inject({ method: "POST", url: "/agent/enroll", headers: { origin: "http://otra-web.lan:9000" }, payload: { enrollToken: "x" } });
    expect(enroll.statusCode).toBe(401); // llega al manejador (token inválido), no se corta por Origin
  });
});
