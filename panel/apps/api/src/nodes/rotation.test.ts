import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string; let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const rotate = (id = nodeId) => app.inject({ method: "POST", url: `/api/nodes/${id}/rotate-token`, headers: { cookie } });
const node = async () => (await app.inject({ method: "GET", url: "/api/nodes", headers: { cookie } })).json().find((n: { id: string }) => n.id === nodeId);
const connect = async (token: string) => {
  const agent = new FakeAgent(url, token);
  await agent.connect();
  await agent.handshake();
  await app.agents.get(nodeId)!.ready;
  return agent;
};
/** Arranca la rotación y devuelve la petición en curso y el RotateToken que recibe el agente. */
const startRotation = async (agent: FakeAgent) => {
  const res = rotate();
  const msg = await agent.waitFor("rotateToken");
  if (msg.body.case !== "rotateToken") throw new Error();
  return { res, msg, token: msg.body.value.token };
};

describe("rotación del token de un nodo", () => {
  it("404 sin nodo y 409 con el nodo desconectado (sin dejar nada pendiente)", async () => {
    expect((await rotate("no-existe")).statusCode).toBe(404);
    const res = await rotate();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desconectado/);
    expect((await node()).tokenRotationPending).toBe(false);
  });

  it("un nodo cuyo socket ya se cerró (aún en el registro) es 409 sin dejar pendiente", async () => {
    const agent = await connect(nodeToken);
    app.agents.get(nodeId)!.terminate(); // el socket del panel ya no está abierto, pero el registro aún no se enteró
    const res = await rotate();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desconectado/);
    expect((await node()).tokenRotationPending).toBe(false);
    agent.close();
  });

  it("los dos tokens valen hasta que el agente conecta con el nuevo; después solo el nuevo", async () => {
    const agent = await connect(nodeToken);
    const { res, msg, token } = await startRotation(agent);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    agent.ack(msg.id);
    const r = await res;
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: nodeId, tokenRotationPending: true });
    agent.close();
    const old = await connect(nodeToken); // el agente pudo no guardarlo: el viejo sigue valiendo mientras tanto
    old.close();
    const fresh = await connect(token);
    expect((await node()).tokenRotationPending).toBe(false);
    fresh.close();
    await expect(new FakeAgent(url, nodeToken).connect()).rejects.toThrow(/401/);
    const evs = (await app.inject({ method: "GET", url: "/api/events", headers: { cookie } })).json();
    expect(evs[0]).toMatchObject({ kind: "token_rotated", nodeId, level: "info" });
  });

  it("una segunda rotación con una pendiente reciente es 409", async () => {
    const agent = await connect(nodeToken);
    const { res, msg } = await startRotation(agent);
    agent.ack(msg.id);
    expect((await res).statusCode).toBe(200);
    const again = await rotate();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/rotación en curso/);
    agent.close();
  });

  it("un agente sin soporte deja el token como estaba", async () => {
    const agent = await connect(nodeToken);
    const { res, msg } = await startRotation(agent);
    agent.send({ id: msg.id, body: { case: "error", value: { code: "unsupported", message: "mensaje no soportado" } } });
    const r = await res;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/actualízalo/);
    expect((await node()).tokenRotationPending).toBe(false);
    agent.close();
    (await connect(nodeToken)).close();
  });

  it.each([["io_error", 502], ["invalid_request", 400]])("un error %s del agente borra el pendiente (HTTP %i)", async (code, status) => {
    const agent = await connect(nodeToken);
    const { res, msg } = await startRotation(agent);
    agent.send({ id: msg.id, body: { case: "error", value: { code, message: "no pude guardarlo" } } });
    const r = await res;
    expect(r.statusCode).toBe(status);
    expect((await node()).tokenRotationPending).toBe(false);
    agent.close();
    (await connect(nodeToken)).close();
  });

  it("sin confirmación del agente el token nuevo queda pendiente (pudo guardarlo)", async () => {
    const agent = await connect(nodeToken);
    const { res, token } = await startRotation(agent);
    agent.close();
    const r = await res;
    expect(r.statusCode).toBe(504);
    expect((await node()).tokenRotationPending).toBe(true);
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    (await connect(token)).close();
    expect((await node()).tokenRotationPending).toBe(false);
  });
});
