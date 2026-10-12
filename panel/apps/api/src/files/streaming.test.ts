import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { specSchema } from "@mcsm/shared";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { FakeAgent } from "../../test/fake-agent.js";
import { ManualTimers } from "../../test/manual-timers.js";
import { ACK_TIMEOUT_MS } from "./service.js";
import { DRAIN_MAX_BYTES, IDLE_TIMEOUT_MS } from "./stream.js";

let app: FastifyInstance; let url: string; let cookie: string;
let nodeId: string; let nodeToken: string; let serverId: string; let agent: FakeAgent;
let closed = false;
/** Reloj virtual de los plazos de inactividad y del Ack: nada vence si el test no avanza. */
let clock: ManualTimers;

const spec = specSchema.parse({ type: "FABRIC", version: "1.21.4", memory: "2G", ports: { game: 25565 }, rconPassword: "abcdefgh" });

beforeEach(async () => {
  closed = false;
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
  serverId = app.servers.create({ nodeId, name: "Uno", slug: "uno", spec, desiredState: "stopped" }).id;
  clock = new ManualTimers();
  app.filesService.timers = clock;
  agent = new FakeAgent(url, nodeToken);
  await agent.connect();
  await agent.handshake();
});
afterEach(async () => {
  agent.close();
  if (!closed) await app.close();
});

const files = () => `${url}/api/servers/${serverId}/files`;
const agentAuth = () => ({ authorization: `Bearer ${nodeToken}` });
const octet = { "content-type": "application/octet-stream" };

type Outcome = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean } | "cortada";
/** La respuesta no llegó entera: la conexión se cayó antes de las cabeceras o a mitad del cuerpo. */
const isCut = (o: Outcome) => o === "cortada" || !o.complete;

/**
 * Petición HTTP cruda sin keep-alive (como el cliente Go del agente o un navegador que corta):
 * permite escribir el cuerpo a trozos, esperar al primer trozo de la respuesta y destruirla.
 */
function raw(method: string, target: string, headers: Record<string, string>) {
  const req = http.request(target, { method, headers: { connection: "close", ...headers }, agent: false });
  const chunks: Buffer[] = [];
  let received = 0;
  let gotFirst!: () => void;
  const first = new Promise<void>((r) => (gotFirst = r));
  const outcome = new Promise<Outcome>((resolve) => {
    req.on("response", (res) => {
      res.on("data", (c: Buffer) => { chunks.push(c); received += c.length; gotFirst(); });
      res.on("error", () => {});
      res.once("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
    });
    req.on("error", () => resolve("cortada"));
  });
  return { req, first, outcome, received: () => received };
}

/** Lee del lector hasta haber recibido `n` bytes en total (cuenta acumulada en `acc`). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, acc: { n: number }, n: number) {
  while (acc.n < n) {
    const r = await reader.read();
    if (r.done) throw new Error(`fin con ${acc.n} de ${n} bytes`);
    acc.n += r.value.length;
  }
}

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { while (!(await reader.read()).done); };

/** Escribe y espera a que el socket lo acepte (no a que el otro extremo lo lea). */
const write = (req: http.ClientRequest, data: Buffer) => new Promise<void>((resolve, reject) => req.write(data, (e) => (e ? reject(e) : resolve())));

async function downloadRequest(path: string) {
  const req = await agent.waitFor("filesDownload");
  if (req.body.case !== "filesDownload") throw new Error();
  expect(req.body.value.path).toBe(path);
  return { id: req.id, transferId: req.body.value.transferId };
}

async function uploadRequest() {
  const req = await agent.waitFor("filesUpload");
  if (req.body.case !== "filesUpload") throw new Error();
  return { id: req.id, transferId: req.body.value.transferId, size: req.body.value.size, path: req.body.value.path };
}

const agentError = (id: bigint, code: string, message: string) => agent.send({ id, body: { case: "error", value: { code, message } } });

describe("descarga navegador ← panel ← agente", () => {
  it("reenvía el PUT del agente con nombre, tamaño y tipo seguros", async () => {
    const browser = fetch(`${files()}/download?path=${encodeURIComponent("/world/mundo ñ.dat")}`, { headers: { cookie } });
    const req = await downloadRequest("/world/mundo ñ.dat");
    const data = Buffer.alloc(3 * 1024 * 1024, 9);
    // el PUT del agente no termina hasta que el navegador lo ha leído entero: no se espera aquí
    const put = fetch(`${url}/agent/transfer/${req.transferId}`, { method: "PUT", body: data, headers: { ...agentAuth(), ...octet } });
    const res = await browser;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-length")).toBe(String(data.length));
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="mundo _.dat"; filename*=UTF-8''mundo%20%C3%B1.dat`);
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
    expect((await put).status).toBe(204);
    agent.ack(req.id);
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("un fichero vacío se descarga con Content-Length 0", async () => {
    const browser = fetch(`${files()}/download?path=/vacio.txt`, { headers: { cookie } });
    const req = await downloadRequest("/vacio.txt");
    const put = fetch(`${url}/agent/transfer/${req.transferId}`, { method: "PUT", headers: { ...agentAuth(), ...octet, "content-length": "0" } });
    const res = await browser;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect((await put).status).toBe(204);
    agent.ack(req.id);
  });

  it("si el agente responde Error antes de subir, el navegador recibe ese error en JSON", async () => {
    const browser = fetch(`${files()}/download?path=/mods`, { headers: { cookie } });
    const req = await downloadRequest("/mods");
    agentError(req.id, "is_dir", "es una carpeta: /mods");
    const res = await browser;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("es una carpeta: /mods");
    expect(app.transfers.pendingCount).toBe(0); // la transferencia se canceló
  });

  it("nodo ocupado (busy) → 409 con el mensaje del agente", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    agentError(req.id, "busy", "el nodo ya tiene 4 transferencias de archivos en curso: espera a que termine alguna");
    const res = await browser;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/4 transferencias/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("si el agente confirma sin haber subido nada → 502", async () => {
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie } });
    const req = await downloadRequest("/a.bin");
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/sin enviar/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("si el agente no sube a tiempo, el navegador recibe 504", async () => {
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie } });
    await downloadRequest("/a.bin"); // el agente nunca hace el PUT
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(app.transfers.sweep()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const res = await browser;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/a tiempo/);
  });

  it("ruta insegura → 400 sin hablar con el agente", async () => {
    const res = await fetch(`${files()}/download?path=../../etc/passwd`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("sin sesión → 401 y HEAD → 404, sin pedir nada al agente", async () => {
    expect((await fetch(`${files()}/download?path=/a.bin`)).status).toBe(401);
    expect((await fetch(`${files()}/download?path=/a.bin`, { method: "HEAD", headers: { cookie } })).status).toBe(404);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("el navegador cancela antes de que el agente suba: la transferencia se anula y el PUT tardío es 404", async () => {
    const ctrl = new AbortController();
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie }, signal: ctrl.signal }).catch(() => "cancelada");
    const req = await downloadRequest("/a.bin");
    expect(app.transfers.pendingCount).toBe(1);
    ctrl.abort();
    expect(await browser).toBe("cancelada");
    await vi.waitFor(() => expect(app.transfers.pendingCount).toBe(0));
    const put = await fetch(`${url}/agent/transfer/${req.transferId}`, { method: "PUT", body: "x", headers: { ...agentAuth(), ...octet } });
    expect(put.status).toBe(404);
  });

  it("el navegador cancela a mitad: el PUT del agente se corta y la transferencia sale del registro", async () => {
    const ctrl = new AbortController();
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie }, signal: ctrl.signal });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(64 << 20) });
    await write(put.req, Buffer.alloc(256 * 1024, 1));
    const res = await browser;
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ctrl.abort();
    expect(isCut(await put.outcome)).toBe(true); // el agente ve el corte y descarta lo enviado
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("si cae el WebSocket del agente a mitad, la descarga HTTP sigue y el navegador recibe el fichero entero", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const total = 2 * 1024 * 1024;
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(total) });
    await write(put.req, Buffer.alloc(total / 2, 5));
    const res = await browser;
    expect(res.status).toBe(200);
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    put.req.end(Buffer.alloc(total / 2, 5));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(total);
    expect(await put.outcome).toMatchObject({ status: 204 });
  });

  it("si se corta el PUT del agente a mitad, el navegador ve la descarga truncada (no un fichero corto dado por bueno)", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(1 << 20) });
    await write(put.req, Buffer.alloc(64 * 1024, 1));
    const res = await browser;
    expect(res.headers.get("content-length")).toBe(String(1 << 20));
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    put.req.destroy();
    await expect((async () => { while (!(await reader.read()).done); })()).rejects.toThrow();
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("si el nodo se calla a mitad, a los 120 s sin bytes se cancela: PUT del agente cortado y descarga truncada", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(1 << 20) });
    await write(put.req, Buffer.alloc(1024, 1));
    const res = await browser;
    const reader = res.body!.getReader();
    await readUntil(reader, { n: 0 }, 1024); // todo lo enviado ya cruzó la guarda
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(app.transfers.activeCount).toBe(1);
    clock.advance(1);
    expect(isCut(await put.outcome)).toBe(true);
    await expect(readToEnd(reader)).rejects.toThrow();
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("si el nodo envía las cabeceras del PUT pero ningún byte, a los 120 s el navegador recibe 504 en JSON (no un fichero)", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": "1000" });
    put.req.flushHeaders();
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // el panel ya tiene el PUT y vigila
    clock.advance(IDLE_TIMEOUT_MS);
    const res = await browser;
    expect(res.status).toBe(504);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect((await res.json()).error).toMatch(/dejó de enviar/);
    expect(isCut(await put.outcome)).toBe(true);
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("un WebSocket que parpadea no mata una descarga que sigue fluyendo; el aviso del Ack perdido va a info", async () => {
    const info = vi.spyOn(app.log, "info");
    const warn = vi.spyOn(app.log, "warn");
    const CH = 64 * 1024, N = 4;
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(CH * N) });
    await write(put.req, Buffer.alloc(CH, 0));
    const res = await browser;
    const reader = res.body!.getReader();
    const got = { n: 0 };
    await readUntil(reader, got, CH);
    // El WS cae y vuelve; el PUT sigue.
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    // Más de 120 s en total, pero nunca 120 s seguidos sin bytes.
    for (let i = 1; i < N; i++) {
      clock.advance(IDLE_TIMEOUT_MS - 1000);
      if (i === N - 1) put.req.end(Buffer.alloc(CH, i));
      else await write(put.req, Buffer.alloc(CH, i));
      await readUntil(reader, got, CH * (i + 1));
    }
    expect((await reader.read()).done).toBe(true);
    expect(got.n).toBe(CH * N);
    expect(await put.outcome).toMatchObject({ status: 204 });
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: "/world.zip" }), expect.stringMatching(/entera/)));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("subida navegador → panel → agente", () => {
  it("50 MiB en streaming: el agente recibe datos antes de que el navegador termine de enviar", async () => {
    const CHUNK = 1024 * 1024, CHUNKS = 50;
    let openGate!: () => void;
    const agentStarted = new Promise<void>((r) => (openGate = r));
    let sent = 0;
    const local = createHash("sha256");
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent === 1) await agentStarted; // sin streaming real esto no avanzaría nunca
        if (sent === CHUNKS) return c.close();
        const chunk = new Uint8Array(CHUNK).fill(sent++ % 251);
        local.update(chunk);
        c.enqueue(chunk);
      },
    });
    const init: RequestInit & { duplex: "half" } = { method: "PUT", body, duplex: "half", headers: { cookie, ...octet } };
    const browser = fetch(`${files()}/upload?path=/mods/grande.jar`, init);

    const req = await agent.waitFor("filesUpload");
    if (req.body.case !== "filesUpload") throw new Error();
    expect(req.body.value).toMatchObject({ serverId, path: "/mods/grande.jar", size: -1n }); // chunked: tamaño desconocido
    const res = await fetch(`${url}/agent/transfer/${req.body.value.transferId}`, { headers: agentAuth() });
    const remote = createHash("sha256");
    let n = 0;
    for await (const chunk of res.body!) {
      n += chunk.length;
      remote.update(chunk);
      openGate();
    }
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
    expect(n).toBe(CHUNK * CHUNKS);
    expect(remote.digest("hex")).toBe(local.digest("hex"));
  });

  it("con Content-Length el agente recibe el tamaño y la cabecera", async () => {
    const data = Buffer.alloc(1000, 1);
    const browser = fetch(`${files()}/upload?path=/eula.txt`, { method: "PUT", body: data, headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(1000n);
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(res.headers.get("content-length")).toBe("1000");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
  });

  it("el tope de 16 MiB del cuerpo inline no se aplica a la subida (20 MiB con Content-Length)", async () => {
    const data = Buffer.alloc(20 * 1024 * 1024, 7);
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: data, headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(BigInt(data.length));
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
  });

  it("un fichero vacío se sube con tamaño 0", async () => {
    const browser = fetch(`${files()}/upload?path=/vacio.txt`, { method: "PUT", body: Buffer.alloc(0), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(0n);
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
  });

  it("si el agente corta y responde Error, el navegador recibe ese error y no un corte de red", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(8 * 1024 * 1024, 2), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const ctrl = new AbortController();
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth(), signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // algo de datos y luego "disco lleno"
    ctrl.abort();
    agentError(req.id, "io_error", "error de E/S en /mods/x.jar: no space left on device");
    const out = await browser;
    expect(out.status).toBe(502);
    expect((await out.json()).error).toMatch(/no space left/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("si el agente no reclama la transferencia a tiempo, el navegador recibe 504", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(1024, 3), headers: { cookie, ...octet } });
    await agent.waitFor("filesUpload"); // el agente nunca hace el GET
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(app.transfers.sweep()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const res = await browser;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/a tiempo/);
  });

  it("tipo de contenido distinto de octet-stream → 415 en castellano", async () => {
    const res = await fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: "x", headers: { cookie, "content-type": "application/java-archive" } });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/Tipo de contenido/);
    const none = await fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", headers: { cookie } });
    expect(none.status).toBe(415);
    expect((await none.json()).error).toMatch(/octet-stream/);
  });

  it("subir a la raíz o a una ruta insegura → 400", async () => {
    for (const p of ["/", "../x.jar"]) {
      const res = await fetch(`${files()}/upload?path=${encodeURIComponent(p)}`, { method: "PUT", body: "x", headers: { cookie, ...octet } });
      expect(res.status).toBe(400);
    }
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("sin sesión → 401 sin crear la transferencia", async () => {
    const res = await fetch(`${files()}/upload?path=/x.jar`, { method: "PUT", body: "x", headers: octet });
    expect(res.status).toBe(401);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("nodo ocupado (busy) → 409 con el mensaje del agente, tras drenar el cuerpo", async () => {
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: Buffer.alloc(4 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    agentError(req.id, "busy", "el nodo ya tiene 4 transferencias de archivos en curso: espera a que termine alguna");
    const res = await browser;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/4 transferencias/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("tamaño excedido antes de empezar (Content-Length) → 413 con el mensaje del agente", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: data, headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(BigInt(data.length));
    agentError(req.id, "too_large", "la subida supera el máximo de 1 MiB del nodo (UPLOAD_MAX_BYTES)");
    const res = await browser;
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/UPLOAD_MAX_BYTES/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("tamaño excedido a mitad (chunked): el agente corta, el cuerpo se drena y el navegador recibe 413", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    expect(req.size).toBe(-1n);
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    get.req.destroy(); // el agente llega a su tope y deja de leer
    agentError(req.id, "too_large", "la subida supera el máximo de 1 MiB del nodo (UPLOAD_MAX_BYTES)");
    // El navegador sigue enviando: el panel lo descarta y al final responde con el error.
    await write(up.req, Buffer.alloc(1024 * 1024, 2));
    up.req.end(Buffer.alloc(1024 * 1024, 3));
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 413, complete: true });
    if (out !== "cortada") expect(JSON.parse(out.body.toString()).error).toMatch(/UPLOAD_MAX_BYTES/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("el navegador cancela antes de que el agente reclame: la transferencia se anula y el GET tardío es 404", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(1 << 20) });
    await write(up.req, Buffer.alloc(1024, 1));
    const req = await uploadRequest();
    expect(app.transfers.pendingCount).toBe(1);
    up.req.destroy();
    expect(await up.outcome).toBe("cortada");
    await vi.waitFor(() => expect(app.transfers.pendingCount).toBe(0));
    const get = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(get.status).toBe(404);
  });

  it("el navegador cancela a mitad: el GET del agente se corta (no recibe un fichero corto como bueno)", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(8 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    up.req.destroy();
    expect(isCut(await get.outcome)).toBe(true);
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("el agente se desconecta a mitad: su GET se corta y el navegador recibe 409 en JSON", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(4 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    agent.close();
    // El panel abandona la transferencia: el agente (que sigue vivo) ve su GET cortado y limpia.
    expect(isCut(await get.outcome)).toBe(true);
    up.req.end(Buffer.alloc((4 << 20) - 256 * 1024, 2));
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 409, complete: true });
    if (out !== "cortada") expect(JSON.parse(out.body.toString()).error).toMatch(/desconect/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("con el nodo desconectado desde el principio → 409 en JSON (el cuerpo se drena, sin corte de red)", async () => {
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    const res = await fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: Buffer.alloc(2 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/desconectado/);
    expect(app.transfers.pendingCount).toBe(0);
  });
});

describe("subida: plazos y límites", () => {
  it("si el navegador se calla a mitad, a los 120 s se cancela; tras otros 120 s de silencio se cierra su conexión", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(4 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await vi.waitFor(() => expect(get.received()).toBe(256 * 1024)); // todo lo enviado ya cruzó la guarda
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(app.transfers.activeCount).toBe(1);
    clock.advance(1);
    expect(isCut(await get.outcome)).toBe(true); // el agente ve el corte y descarta su temporal
    agentError(req.id, "transfer_failed", "fallo en la transferencia: unexpected EOF");
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // drenando, con su propio plazo
    clock.advance(IDLE_TIMEOUT_MS);
    expect(await up.outcome).toBe("cortada");
    expect(app.transfers.activeCount).toBe(0);
  });

  it("una subida lenta pero continua no tiene plazo absoluto", async () => {
    const CH = 1024, N = 40; // 40 × 119 s ≈ 79 min de reloj virtual
    const up = raw("PUT", `${files()}/upload?path=/lento.bin`, { cookie, ...octet, "content-length": String(CH * N) });
    await write(up.req, Buffer.alloc(CH, 0));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    for (let i = 1; i < N; i++) {
      // El último trozo de una subida con tamaño se retiene hasta el final (exactly): se espera al anterior.
      await vi.waitFor(() => expect(get.received()).toBe(CH * i));
      clock.advance(IDLE_TIMEOUT_MS - 1000);
      if (i === N - 1) up.req.end(Buffer.alloc(CH, i));
      else await write(up.req, Buffer.alloc(CH, i));
    }
    expect(await get.outcome).toMatchObject({ status: 200, complete: true });
    agent.ack(req.id);
    expect(await up.outcome).toMatchObject({ status: 204 });
  });

  it("si el agente recibe el fichero entero pero no confirma, el navegador recibe 504 al vencer el plazo del Ack", async () => {
    const browser = fetch(`${files()}/upload?path=/eula.txt`, { method: "PUT", body: Buffer.alloc(1000, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // solo queda el plazo del Ack
    clock.advance(ACK_TIMEOUT_MS - 1);
    clock.advance(1);
    const out = await browser;
    expect(out.status).toBe(504);
    expect((await out.json()).error).toMatch(/no confirmó/);
  });

  it("si el agente confirma sin haber hecho el GET, el navegador recibe 502 (no un 204 sin fichero)", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(1000, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/sin haber recibido el fichero/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("si el agente confirma con el GET cortado a medias, el navegador recibe 502", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(4 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    get.req.destroy();
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/entero/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("si falla con más de 8 MiB aún por llegar, se drenan 8 MiB y se responde con Connection: close sin esperar al resto", async () => {
    // keep-alive: el Connection: close de la respuesta tiene que ponerlo el panel, no ser eco del cliente.
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, connection: "keep-alive", "content-length": String(64 << 20) });
    up.req.write(Buffer.alloc(1024));
    const req = await uploadRequest();
    agentError(req.id, "busy", "el nodo ya tiene 4 transferencias de archivos en curso: espera a que termine alguna");
    up.req.write(Buffer.alloc(DRAIN_MAX_BYTES + 64 * 1024)); // y nunca envía el resto de los 64 MiB
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 409, complete: true });
    if (out === "cortada") throw new Error();
    expect(out.headers.connection).toBe("close");
    expect(JSON.parse(out.body.toString()).error).toMatch(/4 transferencias/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("si el navegador envía más bytes que su Content-Length, al agente solo llegan los anunciados", async () => {
    const sock = net.connect(Number(new URL(url).port), "127.0.0.1");
    let text = "";
    sock.on("data", (c) => (text += c.toString("latin1")));
    const closedSock = new Promise((r) => sock.once("close", r));
    // Lo que sobra tras los 10 bytes es, para el servidor, la siguiente petición de la conexión.
    sock.write(
      `PUT /api/servers/${serverId}/files/upload?path=/x.txt HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n` +
      `Content-Type: application/octet-stream\r\nContent-Length: 10\r\n\r\n0123456789` +
      `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );
    const req = await uploadRequest();
    expect(req.size).toBe(10n);
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("0123456789");
    agent.ack(req.id);
    await closedSock;
    expect(text.startsWith("HTTP/1.1 204")).toBe(true);
    expect(text).toMatch(/HTTP\/1\.1 200[\s\S]*"ok":true/);
  });
});

describe("cierre del panel con transferencias en curso", () => {
  it("app.close() no espera a que terminen: corta navegador y agente en subida y descarga", async () => {
    // Subida en curso: el navegador envía y el agente lee.
    const up = raw("PUT", `${files()}/upload?path=/up.zip`, { cookie, ...octet, "content-length": String(64 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const upReq = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${upReq.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    // Descarga en curso: el agente sube y el navegador lee.
    const ctrl = new AbortController();
    const browser = fetch(`${files()}/download?path=/down.zip`, { headers: { cookie }, signal: ctrl.signal });
    const dlReq = await downloadRequest("/down.zip");
    const put = raw("PUT", `${url}/agent/transfer/${dlReq.transferId}`, { ...agentAuth(), ...octet, "content-length": String(64 << 20) });
    await write(put.req, Buffer.alloc(256 * 1024, 1));
    const res = await browser;
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(app.transfers.activeCount).toBe(2);

    closed = true;
    await app.close(); // sin el corte esperaría a que los 64 MiB terminasen de pasar

    expect(isCut(await up.outcome)).toBe(true);
    expect(isCut(await get.outcome)).toBe(true);
    expect(isCut(await put.outcome)).toBe(true);
    await expect((async () => { while (!(await reader.read()).done); })()).rejects.toThrow();
    expect(app.transfers.activeCount).toBe(0);
    expect(app.transfers.pendingCount).toBe(0);
  });
});
