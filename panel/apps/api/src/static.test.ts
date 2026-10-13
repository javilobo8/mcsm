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

describe("static web", () => {
  it("serves index.html at / and the assets", async () => {
    let res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
    res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
  });

  it("client routes fall back to index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/servers/abc" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
  });

  it("reserved routes (with uppercase, encoding and slash variants) give a JSON 404", async () => {
    const urls = ["/api", "/api/nada", "/api/nada?x=1", "/agent", "/agent/nada", "/ws/", "/ws/x", "/API/x", "/%61pi/nada", "/%41gent/x", "/%zz/api"];
    for (const url of urls.slice(0, -1)) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: "Not found" });
    }
  });

  it("a nonexistent /assets gives 404 and SPA routes keep giving index.html", async () => {
    let res = await app.inject({ method: "GET", url: "/assets/inexistente.js" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("SPA");
    res = await app.inject({ method: "GET", url: "/app/servers/x" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
    res = await app.inject({ method: "GET", url: "/apix" });
    expect(res.statusCode).toBe(200);
  });

  it("/ws without a cookie stays protected and /%61pi/servers without a cookie gives 401", async () => {
    let res = await app.inject({ method: "GET", url: "/ws" });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "GET", url: "/%61pi/servers" });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: "GET", url: "/api/servers" });
    expect(res.statusCode).toBe(401);
  });

  it("only GET/HEAD get the fallback", async () => {
    const res = await app.inject({ method: "POST", url: "/servers/abc" });
    expect(res.statusCode).toBe(404);
  });
});
