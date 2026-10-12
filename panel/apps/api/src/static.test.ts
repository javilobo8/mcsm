import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db/db.js";

let app: FastifyInstance;
beforeEach(async () => {
  const dist = mkdtempSync(join(tmpdir(), "mcsm-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<html>SPA</html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  app = await buildApp({ db: openDb(":memory:"), config: { webDist: dist } });
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe("web estática", () => {
  it("sirve index.html en / y los assets", async () => {
    let res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
    res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("las rutas del cliente caen en index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/servers/abc" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
  });

  it("/api, /agent y /ws desconocidos dan 404 JSON, y las rutas protegidas siguen dando 401", async () => {
    for (const url of ["/api/nada", "/agent/nada", "/api/nada?x=1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "No encontrado" });
    }
    const res = await app.inject({ method: "GET", url: "/api/servers" });
    expect(res.statusCode).toBe(401);
  });

  it("solo GET/HEAD reciben el fallback", async () => {
    const res = await app.inject({ method: "POST", url: "/servers/abc" });
    expect(res.statusCode).toBe(404);
  });
});
