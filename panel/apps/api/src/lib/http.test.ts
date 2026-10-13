import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { AgentError } from "../agents/hub.js";
import { AgentErrorCode } from "../agents/error-codes.js";
import { HttpError, agentErrorToHttp } from "./http.js";
import { HttpError as HttpErrorFromServers } from "../servers/service.js";

describe("agentErrorToHttp", () => {
  it.each([
    [AgentErrorCode.UnknownServer, 404],
    [AgentErrorCode.NotFound, 404],
    [AgentErrorCode.InvalidRequest, 400],
    [AgentErrorCode.InvalidSpec, 400],
    [AgentErrorCode.Busy, 409],
    [AgentErrorCode.Exists, 409],
    [AgentErrorCode.Disconnected, 409],
    [AgentErrorCode.Syncing, 409],
    [AgentErrorCode.Unsupported, 409],
    [AgentErrorCode.TooLarge, 413],
    [AgentErrorCode.InvalidPath, 400],
    [AgentErrorCode.PathOutside, 400],
    [AgentErrorCode.Root, 400],
    [AgentErrorCode.IsDir, 400],
    [AgentErrorCode.NotDir, 400],
    [AgentErrorCode.TransferFailed, 502],
    [AgentErrorCode.IoError, 502],
    [AgentErrorCode.ExternalData, 409],
    [AgentErrorCode.Timeout, 504],
    [AgentErrorCode.PowerFailed, 502],
    ["codigo_nuevo", 502],
  ])("%s → %i", (code, status) => {
    expect(agentErrorToHttp(new AgentError(code, "agent text")).status).toBe(status);
  });

  it("502 keeps the agent/Docker text (spec §10); unsupported asks to update the agent", () => {
    expect(agentErrorToHttp(new AgentError("power_failed", "port is already allocated")).message).toBe("port is already allocated");
    expect(agentErrorToHttp(new AgentError("unsupported", "unknown message: update the agent")).message).toMatch(/agent is out of date/);
  });

  it("returns an HttpError as is and uses the fallback for anything else", () => {
    const h = new HttpError(409, "already exists");
    expect(agentErrorToHttp(h)).toBe(h);
    expect(agentErrorToHttp(new Error("boom"), "Could not")).toMatchObject({ status: 502, message: "Could not" });
  });

  it("servers/service.ts re-exports the same HttpError", () => {
    expect(HttpErrorFromServers).toBe(HttpError);
  });
});

describe("global error handler", () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    app = await buildApp({ db: openDb(":memory:") });
    app.get("/api/__http", async () => { throw new HttpError(409, "Explained conflict"); });
    app.get("/api/__http500", async () => { throw new HttpError(500, "internal detail /path"); });
    app.get("/api/__agent", async () => { throw new AgentError("power_failed", "port is already allocated"); });
    app.get("/api/__zod", async () => z.object({ a: z.string({ error: "Missing a" }) }).parse({}));
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const c = res.cookies.find((c) => c.name === "mcsm_session")!;
    cookie = `${c.name}=${c.value}`;
  });
  afterEach(async () => { await app.close(); });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

  it("4xx HttpError with its message, generic 500, translated AgentError and ZodError → 400", async () => {
    expect((await get("/api/__http")).json()).toEqual({ error: "Explained conflict" });
    const r500 = await get("/api/__http500");
    expect(r500.statusCode).toBe(500);
    expect(r500.json()).toEqual({ error: "Internal error" });
    const ag = await get("/api/__agent");
    expect(ag.statusCode).toBe(502);
    expect(ag.json()).toEqual({ error: "port is already allocated" });
    const zr = await get("/api/__zod");
    expect(zr.statusCode).toBe(400);
    expect(zr.json()).toEqual({ error: "Missing a" });
  });

  it("an internal error outside /api/servers does not leak its message (L7)", async () => {
    app.nodes.list = () => { throw new Error("SQLITE_ERROR /secret/path"); };
    const res = await get("/api/nodes");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal error" });
    app.nodes.enrollNode = () => { throw new Error("UNIQUE constraint failed: nodes.name"); };
    const enroll = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: "x" } });
    expect(enroll.statusCode).toBe(500);
    expect(enroll.body).not.toMatch(/UNIQUE|nodes\.name/);
  });

  it("Fastify errors come out as { error } in English", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{mal" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Invalid request" });
  });
});
