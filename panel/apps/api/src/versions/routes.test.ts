import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { ManualTimers } from "../../test/manual-timers.js";
import { VersionCatalog, type FetchFn } from "./catalog.js";

const FILL = "https://fill.papermc.io/v3/projects/paper";
let app: FastifyInstance;
let cookie: string;
let calls: string[];
let responses: Map<string, () => Response>;

beforeEach(async () => {
  calls = [];
  responses = new Map();
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const r = responses.get(url);
    if (!r) throw new TypeError("no network");
    return r();
  };
  app = await buildApp({
    db: openDb(":memory:"),
    versions: new VersionCatalog({ fetch, now: () => Date.parse("2026-10-13T10:00:00Z"), timers: new ManualTimers() }),
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
});
afterEach(async () => { await app.close(); });

const get = (url: string, withCookie = true) => app.inject({ method: "GET", url, headers: withCookie ? { cookie } : {} });

describe("/api/versions", () => {
  it("requires a session", async () => {
    expect((await get("/api/versions/PAPER", false)).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("Paper version list", async () => {
    responses.set(FILL, () => new Response(JSON.stringify({ project: { id: "paper" }, versions: { "1.21": ["1.21.11", "1.21.11-rc3"] } })));
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: "PAPER", versions: [{ id: "1.21.11", stable: true }, { id: "1.21.11-rc3", stable: false }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
  });

  it("Paper builds: only stable ones", async () => {
    responses.set(`${FILL}/versions/1.20.1/builds`, () => new Response(JSON.stringify([
      { id: 178, channel: "STABLE" }, { id: 177, channel: "BETA" },
    ])));
    const res = await get("/api/versions/PAPER/1.20.1/builds");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: "PAPER", version: "1.20.1", builds: [{ id: "178", stable: true, recommended: false }] });
  });

  it("400 for types without a list, types without builds and invalid versions, without touching the network", async () => {
    expect((await get("/api/versions/MODRINTH")).json()).toEqual({ error: "Type without a version list" });
    expect((await get("/api/versions/VANILLA/1.21.4/builds")).statusCode).toBe(400);
    for (const v of ["..%2F..%2Fetc", "1.21%20", "%00", "a".repeat(65)]) {
      expect((await get(`/api/versions/PAPER/${v}/builds`)).statusCode, v).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("source down with nothing stored: 502 with a message", async () => {
    const res = await get("/api/versions/PAPER");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Could not query the version list of Paper" });
  });
});
