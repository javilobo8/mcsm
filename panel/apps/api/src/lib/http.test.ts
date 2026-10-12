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
    expect(agentErrorToHttp(new AgentError(code, "texto del agente")).status).toBe(status);
  });

  it("502 conserva el texto del agente/Docker (spec §10); unsupported pide actualizar el agente", () => {
    expect(agentErrorToHttp(new AgentError("power_failed", "port is already allocated")).message).toBe("port is already allocated");
    expect(agentErrorToHttp(new AgentError("unsupported", "mensaje desconocido: actualiza el agente")).message).toMatch(/agente del nodo está desactualizado/);
  });

  it("devuelve tal cual un HttpError y usa el fallback para lo demás", () => {
    const h = new HttpError(409, "ya existe");
    expect(agentErrorToHttp(h)).toBe(h);
    expect(agentErrorToHttp(new Error("boom"), "No se pudo")).toMatchObject({ status: 502, message: "No se pudo" });
  });

  it("servers/service.ts re-exporta el mismo HttpError", () => {
    expect(HttpErrorFromServers).toBe(HttpError);
  });
});

describe("manejador de errores global", () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    app = await buildApp({ db: openDb(":memory:") });
    app.get("/api/__http", async () => { throw new HttpError(409, "Conflicto explicado"); });
    app.get("/api/__http500", async () => { throw new HttpError(500, "detalle interno /ruta"); });
    app.get("/api/__agent", async () => { throw new AgentError("power_failed", "port is already allocated"); });
    app.get("/api/__zod", async () => z.object({ a: z.string({ error: "Falta a" }) }).parse({}));
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    const c = res.cookies.find((c) => c.name === "mcsm_session")!;
    cookie = `${c.name}=${c.value}`;
  });
  afterEach(async () => { await app.close(); });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

  it("HttpError 4xx con su mensaje, 500 genérico, AgentError traducido y ZodError → 400", async () => {
    expect((await get("/api/__http")).json()).toEqual({ error: "Conflicto explicado" });
    const r500 = await get("/api/__http500");
    expect(r500.statusCode).toBe(500);
    expect(r500.json()).toEqual({ error: "Error interno" });
    const ag = await get("/api/__agent");
    expect(ag.statusCode).toBe(502);
    expect(ag.json()).toEqual({ error: "port is already allocated" });
    const zr = await get("/api/__zod");
    expect(zr.statusCode).toBe(400);
    expect(zr.json()).toEqual({ error: "Falta a" });
  });

  it("un error interno fuera de /api/servers no filtra su mensaje (L7)", async () => {
    app.nodes.list = () => { throw new Error("SQLITE_ERROR /secreto/ruta"); };
    const res = await get("/api/nodes");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Error interno" });
    app.nodes.enrollNode = () => { throw new Error("UNIQUE constraint failed: nodes.name"); };
    const enroll = await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: "x" } });
    expect(enroll.statusCode).toBe(500);
    expect(enroll.body).not.toMatch(/UNIQUE|nodes\.name/);
  });

  it("los errores de Fastify salen como { error } en castellano", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{mal" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Petición inválida" });
  });
});
