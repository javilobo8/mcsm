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
/** Virtual clock for the inactivity and Ack deadlines: nothing expires unless the test advances. */
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
  serverId = app.servers.create({ nodeId, name: "One", slug: "one", spec, desiredState: "stopped" }).id;
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

type Outcome = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean } | "cut";
/** The response did not arrive in full: the connection dropped before the headers or midway through the body. */
const isCut = (o: Outcome) => o === "cut" || !o.complete;

/**
 * Raw HTTP request without keep-alive (like the agent's Go client or a browser that cuts off):
 * lets the body be written in chunks, wait for the first chunk of the response and destroy it.
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
    req.on("error", () => resolve("cut"));
  });
  return { req, first, outcome, received: () => received };
}

/** Reads from the reader until `n` bytes have been received in total (running count in `acc`). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, acc: { n: number }, n: number) {
  while (acc.n < n) {
    const r = await reader.read();
    if (r.done) throw new Error(`end with ${acc.n} of ${n} bytes`);
    acc.n += r.value.length;
  }
}

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { while (!(await reader.read()).done); };

/** Writes and waits for the socket to accept it (not for the other end to read it). */
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

describe("download browser ← panel ← agent", () => {
  it("forwards the agent's PUT with a safe name, size and type", async () => {
    const browser = fetch(`${files()}/download?path=${encodeURIComponent("/world/mundo ñ.dat")}`, { headers: { cookie } });
    const req = await downloadRequest("/world/mundo ñ.dat");
    const data = Buffer.alloc(3 * 1024 * 1024, 9);
    // the agent's PUT does not end until the browser has read it all: it is not awaited here
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

  it("an empty file is downloaded with Content-Length 0", async () => {
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

  it("if the agent responds Error before uploading, the browser receives that error as JSON", async () => {
    const browser = fetch(`${files()}/download?path=/mods`, { headers: { cookie } });
    const req = await downloadRequest("/mods");
    agentError(req.id, "is_dir", "it is a directory: /mods");
    const res = await browser;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("it is a directory: /mods");
    expect(app.transfers.pendingCount).toBe(0); // the transfer was cancelled
  });

  it("node busy (busy) → 409 with the agent's message", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    agentError(req.id, "busy", "the node already has 4 file transfers in progress: wait for one to finish");
    const res = await browser;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/4 file transfers/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("if the agent confirms without having uploaded anything → 502", async () => {
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie } });
    const req = await downloadRequest("/a.bin");
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/without sending/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("if the agent does not upload in time, the browser receives 504", async () => {
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie } });
    await downloadRequest("/a.bin"); // the agent never does the PUT
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(app.transfers.sweep()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const res = await browser;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/in time/);
  });

  it("unsafe path → 400 without talking to the agent", async () => {
    const res = await fetch(`${files()}/download?path=../../etc/passwd`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("no session → 401 and HEAD → 404, without asking the agent for anything", async () => {
    expect((await fetch(`${files()}/download?path=/a.bin`)).status).toBe(401);
    expect((await fetch(`${files()}/download?path=/a.bin`, { method: "HEAD", headers: { cookie } })).status).toBe(404);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("the browser cancels before the agent uploads: the transfer is voided and the late PUT is 404", async () => {
    const ctrl = new AbortController();
    const browser = fetch(`${files()}/download?path=/a.bin`, { headers: { cookie }, signal: ctrl.signal }).catch(() => "cancelled");
    const req = await downloadRequest("/a.bin");
    expect(app.transfers.pendingCount).toBe(1);
    ctrl.abort();
    expect(await browser).toBe("cancelled");
    await vi.waitFor(() => expect(app.transfers.pendingCount).toBe(0));
    const put = await fetch(`${url}/agent/transfer/${req.transferId}`, { method: "PUT", body: "x", headers: { ...agentAuth(), ...octet } });
    expect(put.status).toBe(404);
  });

  it("the browser cancels midway: the agent's PUT is cut and the transfer leaves the registry", async () => {
    const ctrl = new AbortController();
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie }, signal: ctrl.signal });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(64 << 20) });
    await write(put.req, Buffer.alloc(256 * 1024, 1));
    const res = await browser;
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ctrl.abort();
    expect(isCut(await put.outcome)).toBe(true); // the agent sees the cut and discards what was sent
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("if the agent's WebSocket drops midway, the HTTP download continues and the browser receives the whole file", async () => {
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

  it("if the agent's PUT is cut midway, the browser sees the download truncated (not a short file taken as good)", async () => {
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

  it("if the node goes silent midway, after 120 s without bytes it is cancelled: agent's PUT cut and download truncated", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": String(1 << 20) });
    await write(put.req, Buffer.alloc(1024, 1));
    const res = await browser;
    const reader = res.body!.getReader();
    await readUntil(reader, { n: 0 }, 1024); // everything sent already crossed the guard
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(app.transfers.activeCount).toBe(1);
    clock.advance(1);
    expect(isCut(await put.outcome)).toBe(true);
    await expect(readToEnd(reader)).rejects.toThrow();
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("if the node sends the PUT headers but no byte, after 120 s the browser receives 504 as JSON (not a file)", async () => {
    const browser = fetch(`${files()}/download?path=/world.zip`, { headers: { cookie } });
    const req = await downloadRequest("/world.zip");
    const put = raw("PUT", `${url}/agent/transfer/${req.transferId}`, { ...agentAuth(), ...octet, "content-length": "1000" });
    put.req.flushHeaders();
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // the panel already has the PUT and is watching
    clock.advance(IDLE_TIMEOUT_MS);
    const res = await browser;
    expect(res.status).toBe(504);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect((await res.json()).error).toMatch(/stopped sending/);
    expect(isCut(await put.outcome)).toBe(true);
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("a flickering WebSocket does not kill a download that keeps flowing; the lost-Ack notice goes to info", async () => {
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
    // The WS drops and comes back; the PUT continues.
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.handshake();
    // More than 120 s in total, but never 120 s in a row without bytes.
    for (let i = 1; i < N; i++) {
      clock.advance(IDLE_TIMEOUT_MS - 1000);
      if (i === N - 1) put.req.end(Buffer.alloc(CH, i));
      else await write(put.req, Buffer.alloc(CH, i));
      await readUntil(reader, got, CH * (i + 1));
    }
    expect((await reader.read()).done).toBe(true);
    expect(got.n).toBe(CH * N);
    expect(await put.outcome).toMatchObject({ status: 204 });
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: "/world.zip" }), expect.stringMatching(/in full/)));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("upload browser → panel → agent", () => {
  it("50 MiB streaming: the agent receives data before the browser finishes sending", async () => {
    const CHUNK = 1024 * 1024, CHUNKS = 50;
    let openGate!: () => void;
    const agentStarted = new Promise<void>((r) => (openGate = r));
    let sent = 0;
    const local = createHash("sha256");
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (sent === 1) await agentStarted; // without real streaming this would never advance
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
    expect(req.body.value).toMatchObject({ serverId, path: "/mods/grande.jar", size: -1n }); // chunked: unknown size
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

  it("with Content-Length the agent receives the size and the header", async () => {
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

  it("the 16 MiB cap on the inline body does not apply to the upload (20 MiB with Content-Length)", async () => {
    const data = Buffer.alloc(20 * 1024 * 1024, 7);
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: data, headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(BigInt(data.length));
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
  });

  it("an empty file is uploaded with size 0", async () => {
    const browser = fetch(`${files()}/upload?path=/vacio.txt`, { method: "PUT", body: Buffer.alloc(0), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(0n);
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    agent.ack(req.id);
    expect((await browser).status).toBe(204);
  });

  it("if the agent cuts off and responds Error, the browser receives that error and not a network cut", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(8 * 1024 * 1024, 2), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const ctrl = new AbortController();
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth(), signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // some data and then "disk full"
    ctrl.abort();
    agentError(req.id, "io_error", "I/O error on /mods/x.jar: no space left on device");
    const out = await browser;
    expect(out.status).toBe(502);
    expect((await out.json()).error).toMatch(/no space left/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the agent does not claim the transfer in time, the browser receives 504", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(1024, 3), headers: { cookie, ...octet } });
    await agent.waitFor("filesUpload"); // the agent never does the GET
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect(app.transfers.sweep()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const res = await browser;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/in time/);
  });

  it("content type other than octet-stream → 415 in English", async () => {
    const res = await fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: "x", headers: { cookie, "content-type": "application/java-archive" } });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/Unsupported content type/);
    const none = await fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", headers: { cookie } });
    expect(none.status).toBe(415);
    expect((await none.json()).error).toMatch(/octet-stream/);
  });

  it("uploading to the root or to an unsafe path → 400", async () => {
    for (const p of ["/", "../x.jar"]) {
      const res = await fetch(`${files()}/upload?path=${encodeURIComponent(p)}`, { method: "PUT", body: "x", headers: { cookie, ...octet } });
      expect(res.status).toBe(400);
    }
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("no session → 401 without creating the transfer", async () => {
    const res = await fetch(`${files()}/upload?path=/x.jar`, { method: "PUT", body: "x", headers: octet });
    expect(res.status).toBe(401);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("node busy (busy) → 409 with the agent's message, after draining the body", async () => {
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: Buffer.alloc(4 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    agentError(req.id, "busy", "the node already has 4 file transfers in progress: wait for one to finish");
    const res = await browser;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/4 file transfers/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("size exceeded before starting (Content-Length) → 413 with the agent's message", async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 1);
    const browser = fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: data, headers: { cookie, ...octet } });
    const req = await uploadRequest();
    expect(req.size).toBe(BigInt(data.length));
    agentError(req.id, "too_large", "the upload exceeds the node's 1 MiB maximum (UPLOAD_MAX_BYTES)");
    const res = await browser;
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/UPLOAD_MAX_BYTES/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("size exceeded midway (chunked): the agent cuts off, the body is drained and the browser receives 413", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    expect(req.size).toBe(-1n);
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    get.req.destroy(); // the agent reaches its cap and stops reading
    agentError(req.id, "too_large", "the upload exceeds the node's 1 MiB maximum (UPLOAD_MAX_BYTES)");
    // The browser keeps sending: the panel discards it and at the end responds with the error.
    await write(up.req, Buffer.alloc(1024 * 1024, 2));
    up.req.end(Buffer.alloc(1024 * 1024, 3));
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 413, complete: true });
    if (out !== "cut") expect(JSON.parse(out.body.toString()).error).toMatch(/UPLOAD_MAX_BYTES/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("the browser cancels before the agent claims: the transfer is voided and the late GET is 404", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(1 << 20) });
    await write(up.req, Buffer.alloc(1024, 1));
    const req = await uploadRequest();
    expect(app.transfers.pendingCount).toBe(1);
    up.req.destroy();
    expect(await up.outcome).toBe("cut");
    await vi.waitFor(() => expect(app.transfers.pendingCount).toBe(0));
    const get = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect(get.status).toBe(404);
  });

  it("the browser cancels midway: the agent's GET is cut (it does not receive a short file as good)", async () => {
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

  it("the agent disconnects midway: its GET is cut and the browser receives 409 as JSON", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(4 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    agent.close();
    // The panel abandons the transfer: the agent (which is still alive) sees its GET cut and cleans up.
    expect(isCut(await get.outcome)).toBe(true);
    up.req.end(Buffer.alloc((4 << 20) - 256 * 1024, 2));
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 409, complete: true });
    if (out !== "cut") expect(JSON.parse(out.body.toString()).error).toMatch(/disconnect/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("with the node offline from the start → 409 as JSON (the body is drained, without a network cut)", async () => {
    agent.close();
    await vi.waitFor(() => expect(app.agents.get(nodeId)).toBeUndefined());
    const res = await fetch(`${files()}/upload?path=/world.zip`, { method: "PUT", body: Buffer.alloc(2 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/offline/);
    expect(app.transfers.pendingCount).toBe(0);
  });
});

describe("upload: deadlines and limits", () => {
  it("if the browser goes silent midway, it is cancelled after 120 s; after another 120 s of silence its connection is closed", async () => {
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, "content-length": String(4 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await vi.waitFor(() => expect(get.received()).toBe(256 * 1024)); // everything sent already crossed the guard
    clock.advance(IDLE_TIMEOUT_MS - 1);
    expect(app.transfers.activeCount).toBe(1);
    clock.advance(1);
    expect(isCut(await get.outcome)).toBe(true); // the agent sees the cut and discards its temp file
    agentError(req.id, "transfer_failed", "transfer failure: unexpected EOF");
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // draining, with its own deadline
    clock.advance(IDLE_TIMEOUT_MS);
    expect(await up.outcome).toBe("cut");
    expect(app.transfers.activeCount).toBe(0);
  });

  it("a slow but continuous upload has no absolute deadline", async () => {
    const CH = 1024, N = 40; // 40 × 119 s ≈ 79 min of virtual clock
    const up = raw("PUT", `${files()}/upload?path=/lento.bin`, { cookie, ...octet, "content-length": String(CH * N) });
    await write(up.req, Buffer.alloc(CH, 0));
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    for (let i = 1; i < N; i++) {
      // The last chunk of an upload with a size is held back until the end (exactly): the previous one is awaited.
      await vi.waitFor(() => expect(get.received()).toBe(CH * i));
      clock.advance(IDLE_TIMEOUT_MS - 1000);
      if (i === N - 1) up.req.end(Buffer.alloc(CH, i));
      else await write(up.req, Buffer.alloc(CH, i));
    }
    expect(await get.outcome).toMatchObject({ status: 200, complete: true });
    agent.ack(req.id);
    expect(await up.outcome).toMatchObject({ status: 204 });
  });

  it("if the agent receives the whole file but does not confirm, the browser receives 504 when the Ack deadline expires", async () => {
    const browser = fetch(`${files()}/upload?path=/eula.txt`, { method: "PUT", body: Buffer.alloc(1000, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const res = await fetch(`${url}/agent/transfer/${req.transferId}`, { headers: agentAuth() });
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    await vi.waitFor(() => expect(clock.pending).toBe(1)); // only the Ack deadline remains
    clock.advance(ACK_TIMEOUT_MS - 1);
    clock.advance(1);
    const out = await browser;
    expect(out.status).toBe(504);
    expect((await out.json()).error).toMatch(/did not confirm/);
  });

  it("if the agent confirms without having done the GET, the browser receives 502 (not a 204 without a file)", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(1000, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/without having received the file/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("if the agent confirms with the GET cut off halfway, the browser receives 502", async () => {
    const browser = fetch(`${files()}/upload?path=/mods/x.jar`, { method: "PUT", body: Buffer.alloc(4 * 1024 * 1024, 1), headers: { cookie, ...octet } });
    const req = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${req.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    get.req.destroy();
    agent.ack(req.id);
    const res = await browser;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/whole file/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if it fails with more than 8 MiB still to arrive, 8 MiB are drained and it responds with Connection: close without waiting for the rest", async () => {
    // keep-alive: the response's Connection: close must be set by the panel, not echoed from the client.
    const up = raw("PUT", `${files()}/upload?path=/world.zip`, { cookie, ...octet, connection: "keep-alive", "content-length": String(64 << 20) });
    up.req.write(Buffer.alloc(1024));
    const req = await uploadRequest();
    agentError(req.id, "busy", "the node already has 4 file transfers in progress: wait for one to finish");
    up.req.write(Buffer.alloc(DRAIN_MAX_BYTES + 64 * 1024)); // and it never sends the rest of the 64 MiB
    const out = await up.outcome;
    expect(out).toMatchObject({ status: 409, complete: true });
    if (out === "cut") throw new Error();
    expect(out.headers.connection).toBe("close");
    expect(JSON.parse(out.body.toString()).error).toMatch(/4 file transfers/);
    expect(app.transfers.pendingCount).toBe(0);
  });

  it("if the browser sends more bytes than its Content-Length, only the announced ones reach the agent", async () => {
    const sock = net.connect(Number(new URL(url).port), "127.0.0.1");
    let text = "";
    sock.on("data", (c) => (text += c.toString("latin1")));
    const closedSock = new Promise((r) => sock.once("close", r));
    // What remains after the 10 bytes is, for the server, the connection's next request.
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

describe("panel shutdown with transfers in progress", () => {
  it("app.close() does not wait for them to finish: it cuts browser and agent on upload and download", async () => {
    // Upload in progress: the browser sends and the agent reads.
    const up = raw("PUT", `${files()}/upload?path=/up.zip`, { cookie, ...octet, "content-length": String(64 << 20) });
    await write(up.req, Buffer.alloc(256 * 1024, 1));
    const upReq = await uploadRequest();
    const get = raw("GET", `${url}/agent/transfer/${upReq.transferId}`, agentAuth());
    get.req.end();
    await get.first;
    // Download in progress: the agent uploads and the browser reads.
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
    await app.close(); // without the cut it would wait for the 64 MiB to finish passing

    expect(isCut(await up.outcome)).toBe(true);
    expect(isCut(await get.outcome)).toBe(true);
    expect(isCut(await put.outcome)).toBe(true);
    await expect((async () => { while (!(await reader.read()).done); })()).rejects.toThrow();
    expect(app.transfers.activeCount).toBe(0);
    expect(app.transfers.pendingCount).toBe(0);
  });
});
