import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

const enroll = async (name: string) => {
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json() as { nodeId: string; nodeToken: string };
};

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  ({ nodeId, nodeToken } = await enroll("nas"));
});
afterEach(async () => { await app.close(); });

const post = async (u: string, payload: object) => await app.inject({ method: "POST", url: u, headers: { cookie }, payload });
const patch = async (u: string, payload: object) => await app.inject({ method: "PATCH", url: u, headers: { cookie }, payload });
const routed = (hostname: string, enabled = true) => ({ router: { enabled, hostname } });

describe("servidores y nodos con router", () => {
  it("guarda la sección router y la valida", async () => {
    let res = await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.router).toEqual({ enabled: true, hostname: "survival.lan" });
    res = await post("/api/servers", { nodeId, name: "Mal", spec: routed("Survival.LAN") });
    expect(res.statusCode).toBe(400);
    res = await post("/api/servers", { nodeId, name: "Sin", spec: routed("") });
    expect(res.statusCode).toBe(400);
  });

  it("el hostname es único por nodo entre los servidores con el router activo", async () => {
    const a = (await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") })).json();
    let res = await post("/api/servers", { nodeId, name: "Otro", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("El hostname «survival.lan» ya lo usa el servidor «Survival» de este nodo");
    // Desactivado no compite; activarlo después sí.
    const b = (await post("/api/servers", { nodeId, name: "Creativo", spec: routed("survival.lan", false) })).json();
    expect(b.id).toBeDefined();
    res = await patch(`/api/servers/${b.id}`, { spec: routed("survival.lan") });
    expect(res.statusCode).toBe(409);
    res = await patch(`/api/servers/${b.id}`, { spec: routed("creativo.lan") });
    expect(res.statusCode).toBe(200);
    // Editarse a sí mismo no choca consigo.
    res = await patch(`/api/servers/${a.id}`, { spec: { memory: "3G", ...routed("survival.lan") } });
    expect(res.statusCode).toBe(200);
    // Otro nodo puede usar el mismo hostname (su DNS apunta a otra máquina).
    const other = await enroll("salon");
    res = await post("/api/servers", { nodeId: other.nodeId, name: "Survival", spec: routed("survival.lan") });
    expect(res.statusCode).toBe(201);
  });

  it("con el router activo su puerto no se reparte ni se puede publicar", async () => {
    expect((await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload: { enabled: true } })).statusCode).toBe(200);
    let res = await post("/api/servers", { nodeId, name: "Uno" });
    expect(res.json().spec.ports.game).toBe(25566);
    res = await post("/api/servers", { nodeId, name: "Dos", spec: { ports: { game: 25565 } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/router/);
    res = await post("/api/servers", { nodeId, name: "Tres", spec: { ports: { game: 25570, extra: [{ host: 25565, container: 8100, proto: "tcp", label: "x" }] } } });
    expect(res.statusCode).toBe(409);
    // Desactivado, el puerto vuelve a estar libre.
    await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload: { enabled: false } });
    expect((await post("/api/servers", { nodeId, name: "Cuatro", spec: { ports: { game: 25565 } } })).statusCode).toBe(201);
  });

  it("la spec que recibe el agente lleva el router", async () => {
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    const created = post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") });
    const apply = await agent.waitFor("applySpec");
    if (apply.body.case !== "applySpec") throw new Error();
    expect(JSON.parse(new TextDecoder().decode(apply.body.value.server!.specJson)).router).toEqual({ enabled: true, hostname: "survival.lan" });
    agent.ack(apply.id);
    await created;
    agent.close();
  });

  it("borrar un nodo con el router activo es 409; desactivado se borra con su fila", async () => {
    const put = async (payload: object) => await app.inject({ method: "PUT", url: `/api/nodes/${nodeId}/router`, headers: { cookie }, payload });
    await put({ enabled: true, port: 25590 });
    let res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Desactiva el router del nodo antes de borrarlo");
    await put({ enabled: false, port: 25590 });
    res = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM router_deployments").get()).toEqual({ n: 0 });
  });

  it("una plantilla guardada desde un servidor no lleva el router", async () => {
    const s = (await post("/api/servers", { nodeId, name: "Survival", spec: routed("survival.lan") })).json();
    const res = await post("/api/templates", { name: "Base", fromServerId: s.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec.router).toBeUndefined();
  });
});
