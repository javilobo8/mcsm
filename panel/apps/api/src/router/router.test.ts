import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string;

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

const getRouter = async (id = nodeId) => await app.inject({ method: "GET", url: `/api/nodes/${id}/router`, headers: { cookie } });
const putRouter = async (payload: object, id = nodeId) => await app.inject({ method: "PUT", url: `/api/nodes/${id}/router`, headers: { cookie }, payload });
/** Conecta un agente falso y espera a que el panel procese el Ack de SyncSpecs (`ready`). */
const connect = async () => {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  await app.agents.get(nodeId)!.ready;
  return agent;
};

describe("router de un nodo: configuración", () => {
  it("sin configurar: desactivado en 25565, sin estado; 404 si el nodo no existe", async () => {
    const res = await getRouter();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      nodeId, spec: { enabled: false, port: 25565, autoscale: false, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] }, observed: null, observedAt: null, updatedAt: null,
    });
    expect((await getRouter("no-existe")).statusCode).toBe(404);
    expect((await putRouter({ enabled: true }, "no-existe")).statusCode).toBe(404);
  });

  it("valida la configuración (400) y la guarda con el nodo desconectado", async () => {
    expect((await putRouter({ enabled: true, port: 0 })).statusCode).toBe(400);
    expect((await putRouter({ enabled: true, autoscaleDownAfterMinutes: 2000 })).statusCode).toBe(400);
    const res = await putRouter({ enabled: true, port: 25590, autoscale: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).toEqual({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 10, autoscaleAllowPlayers: [] });
    expect((await putRouter({ enabled: true, autoscale: true, autoscaleAllowPlayers: ["a b"] })).statusCode).toBe(400);
    expect(res.json().updatedAt).not.toBeNull();
    expect((await getRouter()).json().spec.port).toBe(25590);
  });

  it("409 si el puerto del router lo publica un servidor del nodo (juego o extra)", async () => {
    await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno", spec: { ports: { game: 25565, extra: [{ host: 25580, container: 8100, proto: "tcp", label: "mapa" }] } } } });
    for (const port of [25565, 25580]) {
      const res = await putRouter({ enabled: true, port });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/lo usa el servidor «Uno»/);
    }
    // Desactivado no reserva el puerto: se puede guardar.
    expect((await putRouter({ enabled: false, port: 25565 })).statusCode).toBe(200);
  });
});

describe("router de un nodo: agente", () => {
  it("activar envía RouterApply y desactivar RouterRemove; responde tras el Ack", async () => {
    const agent = await connect();
    const put = putRouter({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    const apply = await agent.waitFor("routerApply");
    if (apply.body.case !== "routerApply") throw new Error();
    expect(apply.body.value.spec).toMatchObject({ hostPort: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.ack(apply.id);
    expect((await put).statusCode).toBe(200);

    const off = putRouter({ enabled: false, port: 25590 });
    const remove = await agent.waitFor("routerRemove");
    agent.ack(remove.id);
    expect((await off).json().spec.enabled).toBe(false);
    agent.close();
  });

  it("un agente desactualizado (unsupported) es 409; la configuración queda guardada", async () => {
    const agent = await connect();
    const put = putRouter({ enabled: true, port: 25590 });
    const apply = await agent.waitFor("routerApply");
    agent.send({ id: apply.id, body: { case: "error", value: { code: "unsupported", message: "mensaje desconocido: actualiza el agente" } } });
    const res = await put;
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desactualizado/);
    expect((await getRouter()).json().spec.enabled).toBe(true);
    agent.close();
  });

  it("tras el handshake se reenvía la configuración guardada; sin fila no se envía nada", async () => {
    let agent = await connect();
    // Sin fila: entre el handshake y el siguiente envío (un servidor nuevo) no llega nada del router.
    const created = app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno" } });
    const seen: string[] = [];
    for (let e = await agent.next(); ; e = await agent.next()) {
      seen.push(e.body.case ?? "");
      if (e.body.case === "applySpec") { agent.ack(e.id); break; }
    }
    expect(seen.filter((c) => c.startsWith("router"))).toEqual([]);
    await created;
    const gone = new Promise<void>((r) => app.agents.once("detached", () => r()));
    agent.close();
    await gone;

    await putRouter({ enabled: true, port: 25590 }); // offline: solo se guarda
    agent = await connect();
    const apply = await agent.waitFor("routerApply");
    if (apply.body.case !== "routerApply") throw new Error();
    expect(apply.body.value.spec?.hostPort).toBe(25590);
    agent.ack(apply.id);
    agent.close();
  });

  it("dos cambios seguidos llegan en orden y el último es el vigente", async () => {
    const agent = await connect();
    const a = putRouter({ enabled: true, port: 25590 });
    const b = putRouter({ enabled: true, port: 25591 });
    const first = await agent.waitFor("routerApply");
    agent.ack(first.id);
    const second = await agent.waitFor("routerApply");
    agent.ack(second.id);
    await Promise.all([a, b]);
    if (second.body.case !== "routerApply") throw new Error();
    expect(second.body.value.spec?.hostPort).toBe(25591);
    agent.close();
  });

  it("RouterObserved se guarda, se publica y retira un router que el panel no quiere", async () => {
    const events: unknown[] = [];
    app.events.on("router", (_id: string, dto: unknown) => events.push(dto));
    const agent = await connect();
    // Sin fila y sin router en el agente: no se crea nada.
    agent.send({ body: { case: "routerObserved", value: { configured: false, state: "missing" } } });
    // Sin fila y con router en el agente (BD del panel restaurada): se guarda y se pide retirarlo.
    agent.send({ body: { case: "routerObserved", value: { configured: true, state: "running", containerId: "c1", image: "itzg/mc-router:1.47.1", hostPort: 25565 } } });
    const remove = await agent.waitFor("routerRemove");
    agent.ack(remove.id);
    const dto = (await getRouter()).json();
    expect(dto.spec.enabled).toBe(false);
    expect(dto.observed).toEqual({
      configured: true, state: "running", containerId: "c1", image: "itzg/mc-router:1.47.1", hostPort: 25565, autoscale: false, error: "",
      autoscaleDownAfterMinutes: 0, autoscaleAllowPlayers: [],
    });
    expect(dto.observedAt).not.toBeNull();
    expect(events).toHaveLength(1);
    agent.close();
  });

  it("la spec aplicada en el agente viaja en el estado observado (minutos y lista del autoscale)", async () => {
    const agent = await connect();
    const put = putRouter({ enabled: true, port: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.ack((await agent.waitFor("routerApply")).id);
    await put;
    const changed = new Promise<void>((r) => app.events.once("router", () => r()));
    agent.send({ body: { case: "routerObserved", value: {
      configured: true, state: "running", hostPort: 25590, autoscale: true,
      spec: { hostPort: 25590, autoscale: true, autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] },
    } } });
    await changed;
    expect((await getRouter()).json().observed).toMatchObject({ autoscaleDownAfterMinutes: 30, autoscaleAllowPlayers: ["amigo"] });
    agent.close();
  });
});
