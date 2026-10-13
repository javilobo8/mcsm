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

describe("Origin on requests that write", () => {
  it("a foreign Origin is 403; with no Origin, the host's own or the public URL's pass", async () => {
    expect((await post("http://other-site.lan:9000")).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(200); // curl, agent: they send no Origin
    expect((await post("http://panel.lan:8080")).statusCode).toBe(200);
    app.settings.update({ publicUrl: "http://publica.lan:8080" });
    expect((await post("http://publica.lan:8080")).statusCode).toBe(200);
  });

  it("reads are not checked and /agent/* is left out", async () => {
    const get = await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie, origin: "http://other-site.lan:9000" } });
    expect(get.statusCode).toBe(200);
    const enroll = await app.inject({ method: "POST", url: "/agent/enroll", headers: { origin: "http://other-site.lan:9000" }, payload: { enrollToken: "x" } });
    expect(enroll.statusCode).toBe(401); // reaches the handler (invalid token), not cut off by Origin
  });
});
