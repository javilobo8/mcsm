import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { isResponseCase } from "../agents/hub.js";
import { FakeAgent } from "../../test/fake-agent.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string; let serverId: string;

const spec = specSchema.parse({ type: "PAPER", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
  serverId = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec, desiredState: "stopped" }).id;
});
afterEach(async () => { await app.close(); });

async function online(): Promise<FakeAgent> {
  const agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
  return agent;
}

const get = (u: string) => app.inject({ method: "GET", url: u, headers: { cookie } });
const post = (u: string, payload: object) => app.inject({ method: "POST", url: u, headers: { cookie }, payload });
const files = () => `/api/servers/${serverId}/files`;

describe("archivos: validación antes de tocar al agente", () => {
  it("../../etc/passwd devuelve 400 aunque el nodo esté desconectado", async () => {
    for (const u of [`${files()}?path=../../etc/passwd`, `${files()}/content?path=..%2F..%2Fetc%2Fpasswd`, `${files()}/stat?path=/a/../../b`]) {
      const res = await get(u);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Ruta inválida/);
    }
    expect((await post(`${files()}/rename`, { from: "/a", to: "../x" })).statusCode).toBe(400);
  });

  it("sin sesión 401, servidor inexistente 404, nodo desconectado 409", async () => {
    expect((await app.inject({ method: "GET", url: `${files()}?path=/` })).statusCode).toBe(401);
    expect((await get(`/api/servers/nope/files?path=/`)).statusCode).toBe(404);
    const res = await get(`${files()}?path=/`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/desconectado/);
  });

  it("borrar o renombrar la raíz es 400", async () => {
    await online();
    expect((await app.inject({ method: "DELETE", url: `${files()}?path=/`, headers: { cookie } })).statusCode).toBe(400);
    expect((await post(`${files()}/rename`, { from: "/", to: "/x" })).statusCode).toBe(400);
  });

  it("escribir más de 2 MiB es 413 sin llegar al agente", async () => {
    await online();
    const res = await post(`${files()}/content`, { path: "/a.txt", content: "a".repeat(2 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/2 MiB/);
  });
});

describe("archivos: operaciones inline con el agente", () => {
  it("lista con la ruta normalizada y convierte las entradas", async () => {
    const agent = await online();
    const pending = get(`${files()}?path=mods//`);
    const req = await agent.waitFor("filesList");
    if (req.body.case !== "filesList") throw new Error();
    expect(req.body.value).toMatchObject({ serverId, path: "/mods" });
    agent.send({ id: req.id, body: { case: "filesListResult", value: { entries: [
      { name: "lithium.jar", dir: false, symlink: false, size: 1234n, modTimeUnixMs: 1700000000000n, mode: 0o644 },
    ], truncated: false } } });
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "/mods", truncated: false, entries: [{ name: "lithium.jar", dir: false, symlink: false, size: 1234, modifiedAt: 1700000000000, mode: 0o644 }] });
  });

  it("lee texto UTF-8 y rechaza binarios con 415", async () => {
    const agent = await online();
    let pending = get(`${files()}/content?path=/server.properties`);
    let req = await agent.waitFor("filesRead");
    if (req.body.case !== "filesRead") throw new Error();
    expect(req.body.value.maxBytes).toBe(2 * 1024 * 1024);
    agent.send({ id: req.id, body: { case: "filesReadResult", value: { content: new TextEncoder().encode("motd=¡hola!\n"), size: 13n } } });
    let res = await pending;
    expect(res.json()).toEqual({ path: "/server.properties", content: "motd=¡hola!\n", size: 13 });

    pending = get(`${files()}/content?path=/level.dat`);
    req = await agent.waitFor("filesRead");
    agent.send({ id: req.id, body: { case: "filesReadResult", value: { content: new Uint8Array([0x1f, 0x8b, 0xff, 0x00]), size: 4n } } });
    res = await pending;
    expect(res.statusCode).toBe(415);
  });

  it("traduce los códigos del agente a HTTP conservando su mensaje", async () => {
    const agent = await online();
    const cases: [string, number][] = [["path_outside", 400], ["not_found", 404], ["too_large", 413], ["exists", 409], ["io_error", 502]];
    for (const [code, status] of cases) {
      const pending = get(`${files()}/content?path=/x`);
      const req = await agent.waitFor("filesRead");
      agent.send({ id: req.id, body: { case: "error", value: { code, message: `mensaje ${code}` } } });
      const res = await pending;
      expect(res.statusCode).toBe(status);
      expect(res.json().error).toBe(`mensaje ${code}`);
    }
  });

  it("guarda, crea carpeta, renombra y borra con Ack", async () => {
    const agent = await online();
    // en serie: waitFor descarta los mensajes de otro tipo
    const ops: [() => Promise<{ statusCode: number }>, "filesWrite" | "filesMkdir" | "filesRename" | "filesDelete"][] = [
      [() => post(`${files()}/content`, { path: "server.properties", content: "motd=adiós\n" }), "filesWrite"],
      [() => post(`${files()}/mkdir`, { path: "/plugins" }), "filesMkdir"],
      [() => post(`${files()}/rename`, { from: "/plugins", to: "/plugins-old" }), "filesRename"],
      [() => app.inject({ method: "DELETE", url: `${files()}?path=/plugins-old`, headers: { cookie } }), "filesDelete"],
    ];
    for (const [run, kind] of ops) {
      const pending = run();
      const req = await agent.waitFor(kind);
      if (req.body.case === "filesWrite") {
        expect(req.body.value.path).toBe("/server.properties");
        expect(new TextDecoder().decode(req.body.value.content)).toBe("motd=adiós\n");
      }
      if (req.body.case === "filesRename") expect(req.body.value).toMatchObject({ from: "/plugins", to: "/plugins-old" });
      agent.ack(req.id);
      expect((await pending).statusCode).toBe(204);
    }
  });
});

describe("isResponseCase", () => {
  it("ack, error y cualquier *Result resuelven peticiones; lo demás no", () => {
    for (const c of ["ack", "error", "commandResult", "filesListResult"]) expect(isResponseCase(c)).toBe(true);
    for (const c of ["serverObserved", "hello", "logLine", undefined]) expect(isResponseCase(c)).toBe(false);
  });
});
