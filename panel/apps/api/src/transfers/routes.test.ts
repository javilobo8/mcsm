import http from "node:http";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";
import { contentLength } from "./routes.js";
import { TransferError } from "./service.js";

let app: FastifyInstance; let url: string; let cookie: string;

async function enrollNode(name: string, on: FastifyInstance = app): Promise<{ nodeId: string; nodeToken: string }> {
  const t = (await on.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: name } })).json().token;
  return (await on.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: name, agentVersion: "fake" } })).json();
}

async function setup(on: FastifyInstance): Promise<string> {
  const res = await on.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  return `${c.name}=${c.value}`;
}

async function listen(on: FastifyInstance): Promise<string> {
  await on.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(on.server.address() as any).port}`;
}

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  url = await listen(app);
  cookie = await setup(app);
});
afterEach(async () => { await app.close(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const octet = { "content-type": "application/octet-stream" };

/** Raw GET: resolves with the request and the response as soon as the first chunk of the body arrives. */
function getFirstChunk(path: string, token: string): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}${path}`, { headers: auth(token) }, (res) => {
      res.once("data", () => { res.pause(); resolve({ req, res }); });
    });
    req.on("error", reject);
  });
}

/**
 * Raw GET like the agent's (without keep-alive, like its Go client): status, bytes received and whether
 * the response arrived complete according to its Content-Length. A cut before the headers is status 0.
 */
function agentGet(path: string, token: string): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const req = http.get(`${url}${path}`, { headers: { ...auth(token), connection: "close" }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", () => {});
      res.once("close", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), complete: res.complete }));
    });
    req.on("error", () => resolve({ status: 0, body: Buffer.alloc(0), complete: false }));
  });
}

/** Resolves when the response is cut without finishing (the server destroyed the connection). */
function cutShort(res: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    res.on("error", () => {});
    res.once("close", () => resolve(!res.complete));
    res.resume();
  });
}

describe("GET /agent/transfer/:id (panel → agent)", () => {
  it("serves the body streaming with Content-Length and resolves done", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("hola "), Buffer.from("mundo")]), size: 10 }));
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("hola mundo");
    await expect(t.done).resolves.toBeUndefined();
    expect(app.transfers.activeCount).toBe(0);
  });

  it("an empty file is served with Content-Length 0 and counts as delivered", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([]), size: 0 }));
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect(await res.text()).toBe("");
    await expect(t.done).resolves.toBeUndefined();
  });

  it("with no known size it goes chunked, without Content-Length", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("abc")]), size: null }));
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBe("chunked");
    expect(await res.text()).toBe("abc");
    await expect(t.done).resolves.toBeUndefined();
  });

  it("invalid token → 401; foreign, other node's or reused id → 404", async () => {
    const a = await enrollNode("a");
    const b = await enrollNode("b");
    const t = app.transfers.outbound(a.nodeId, async () => ({ stream: Readable.from([Buffer.from("x")]), size: 1 }));
    expect((await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth("nope") })).status).toBe(401);
    expect((await fetch(`${url}/agent/transfer/${t.id}`)).status).toBe(401);
    expect((await fetch(`${url}/agent/transfer/${t.id}`, { headers: { authorization: a.nodeToken } })).status).toBe(401); // without "Bearer "
    expect((await fetch(`${url}/agent/transfer/inventado`, { headers: auth(a.nodeToken) })).status).toBe(404);
    expect((await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(b.nodeToken) })).status).toBe(404);
    const ok = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(a.nodeToken) });
    expect(ok.status).toBe(200); // the other node's attempt did not burn it
    await ok.text();
    const again = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(a.nodeToken) });
    expect(again.status).toBe(404);
    expect((await again.json()).error).toMatch(/already used/);
  });

  it("HEAD does not exist and does not consume the transfer", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("x")]), size: 1 }));
    expect((await fetch(`${url}/agent/transfer/${t.id}`, { method: "HEAD", headers: auth(nodeToken) })).status).toBe(404);
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("it does not go through the session guard but is not served without a node token either", async () => {
    const { nodeId } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([]), size: 0 }));
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("if the agent cuts off midway, done is rejected with aborted and the source is destroyed", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new PassThrough();
    const t = app.transfers.outbound(nodeId, async () => ({ stream: src, size: 1 << 20 }));
    src.write(Buffer.alloc(64 * 1024));
    const { req } = await getFirstChunk(`/agent/transfer/${t.id}`, nodeToken);
    req.on("error", () => {});
    req.destroy();
    await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    expect(src.destroyed).toBe(true);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the source cannot be opened: 500, done is rejected with that error and nothing stays in progress", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => { throw new Error("ENOENT: staging/x.bin"); });
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal error");
    await expect(t.done).rejects.toThrow(/ENOENT/);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the source rejects with a TransferError (expired or cancelled origin), 410 with its message", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => { throw new TransferError("expired", "The agent did not start the transfer in time"); });
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/in time/);
    await expect(t.done).rejects.toMatchObject({ code: "expired" });
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the source fails before the first byte, done is rejected (it is not taken as delivered)", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new Readable({ read() { this.destroy(new Error("broken disk")); } });
    const t = app.transfers.outbound(nodeId, async () => ({ stream: src, size: 5 }));
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(500);
    await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the source fails midway, the agent sees the cut and done is rejected", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new PassThrough();
    const t = app.transfers.outbound(nodeId, async () => ({ stream: src, size: 1 << 20 }));
    src.write(Buffer.alloc(1024));
    const { res } = await getFirstChunk(`/agent/transfer/${t.id}`, nodeToken);
    const cut = cutShort(res);
    src.destroy(new Error("broken disk"));
    expect(await cut).toBe(true);
    await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    expect(app.transfers.activeCount).toBe(0);
  });

  it("cancel midway cuts the agent's response and destroys the source", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new PassThrough();
    const t = app.transfers.outbound(nodeId, async () => ({ stream: src, size: 1 << 20 }));
    src.write(Buffer.alloc(1024));
    const { res } = await getFirstChunk(`/agent/transfer/${t.id}`, nodeToken);
    const cut = cutShort(res);
    t.cancel("test");
    expect(await cut).toBe(true);
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
    expect(src.destroyed).toBe(true);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the agent leaves while the source is being opened, the source opened late is destroyed", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new PassThrough();
    let invoked!: () => void;
    const sourceInvoked = new Promise<void>((r) => (invoked = r));
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    const t = app.transfers.outbound(nodeId, async () => {
      invoked();
      await opened;
      return { stream: src, size: 3 };
    });
    const req = http.get(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) });
    req.on("error", () => {});
    await sourceInvoked;
    req.destroy();
    await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    expect(app.transfers.activeCount).toBe(0);
    const closed = new Promise((r) => src.once("close", r));
    open();
    await closed;
    expect(src.destroyed).toBe(true);
  });

  it("cancel while the source is being opened cuts the connection at once, without waiting for the origin", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const src = new PassThrough();
    let invoked!: () => void;
    const sourceInvoked = new Promise<void>((r) => (invoked = r));
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    const t = app.transfers.outbound(nodeId, async () => {
      invoked();
      await opened;
      return { stream: src, size: 3 };
    });
    const outcome = new Promise<string>((resolve) => {
      const req = http.get(`${url}/agent/transfer/${t.id}`, { headers: auth(nodeToken) }, (res) => resolve(`response ${res.statusCode}`));
      req.on("error", () => resolve("cut"));
    });
    await sourceInvoked;
    t.cancel("test");
    expect(await outcome).toBe("cut"); // the origin is still opening: it was not waited for
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
    const closed = new Promise((r) => src.once("close", r));
    open();
    await closed; // opened late: destroyed without being served
  });

  it("if the source ends with fewer bytes than announced, the agent sees the cut and done is rejected", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("hola")]), size: 10 }));
    const r = await agentGet(`/agent/transfer/${t.id}`, nodeToken);
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThan(10);
    await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the source delivers more bytes than announced, the agent never receives a complete body", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    // The first chunk already completes the size: whatever arrives afterwards cannot sneak in or make it look good.
    for (const chunks of [["0123456789", "extra"], ["0123456789extra"]]) {
      const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from(chunks.map((c) => Buffer.from(c))), size: 10 }));
      const r = await agentGet(`/agent/transfer/${t.id}`, nodeToken);
      expect(r.status === 200 && r.complete).toBe(false);
      await expect(t.done).rejects.toMatchObject({ code: "aborted" });
    }
    expect(app.transfers.activeCount).toBe(0);
  });

  it("an empty chunk after completing the size does not eat the last chunk", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("hola "), Buffer.from("mundo"), Buffer.alloc(0)]), size: 10 }));
    const r = await agentGet(`/agent/transfer/${t.id}`, nodeToken);
    expect(r).toMatchObject({ status: 200, complete: true });
    expect(r.body.toString()).toBe("hola mundo");
    await expect(t.done).resolves.toBeUndefined();
  });
});

describe("node token on every request, whatever the URL encoding", () => {
  it("/%61gent/transfer/:id reaches the route and requires a token", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("x")]), size: 1 }));
    expect((await fetch(`${url}/%61gent/transfer/${t.id}`)).status).toBe(401);
    expect((await fetch(`${url}/%61gent/transfer/${t.id}`, { headers: auth("nope") })).status).toBe(401);
    expect((await fetch(`${url}/%61gent/%74ransfer/${t.id}`, { headers: { cookie } })).status).toBe(401);
    expect(app.transfers.pendingCount).toBe(1);
    const res = await fetch(`${url}/%61gent/transfer/${t.id}`, { headers: auth(nodeToken) });
    expect(res.status).toBe(200); // same route: the path is decoded when routing
    expect(await res.text()).toBe("x");
  });

  it("PUT with an encoded path also requires a token and does not consume", async () => {
    const { nodeId } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const res = await fetch(`${url}/%61gent/transfer/${t.id}`, { method: "PUT", headers: octet, body: "x" });
    expect(res.status).toBe(401);
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("%2F in the id or the path: 401 without a token and never consumes", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([Buffer.from("x")]), size: 1 }));
    expect((await fetch(`${url}/agent/transfer/${t.id}%2Fx`)).status).toBe(401);
    expect((await fetch(`${url}/agent/transfer/x%2F..%2F${t.id}`)).status).toBe(401);
    expect((await fetch(`${url}/agent/transfer/${t.id}%2Fx`, { headers: auth(nodeToken) })).status).toBe(404);
    expect((await fetch(`${url}/agent%2Ftransfer/${t.id}`)).status).toBe(404); // there is no route
    expect((await fetch(`${url}/agent%2Ftransfer/${t.id}`, { headers: auth(nodeToken) })).status).toBe(404);
    expect(app.transfers.pendingCount).toBe(1);
  });
});

describe("PUT /agent/transfer/:id (agent → panel)", () => {
  it("delivers the body to whoever waits and responds 204 once it has been read in full", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const put = fetch(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet }, body: Buffer.alloc(3 * 1024 * 1024, 7) });
    const incoming = await t.incoming;
    expect(incoming.size).toBe(3 * 1024 * 1024);
    let n = 0;
    for await (const c of incoming.stream) n += (c as Buffer).length;
    expect(n).toBe(3 * 1024 * 1024);
    expect((await put).status).toBe(204);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("an empty file arrives as an empty body with size 0", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const put = fetch(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet, "content-length": "0" } });
    const incoming = await t.incoming;
    expect(incoming.size).toBe(0);
    for await (const _ of incoming.stream) throw new Error("there should have been no data");
    expect((await put).status).toBe(204);
  });

  it("chunked: unknown size (null)", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const req = http.request(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet } });
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
    });
    req.write("uno ");
    req.end("dos");
    const incoming = await t.incoming;
    expect(incoming.size).toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of incoming.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("uno dos");
    expect(await status).toBe(204);
  });

  it("PUT on an outbound or unclaimed transfer → 404 without consuming it", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const out = app.transfers.outbound(nodeId, async () => ({ stream: Readable.from([]), size: 0 }));
    const res = await fetch(`${url}/agent/transfer/${out.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet }, body: "x" });
    expect(res.status).toBe(404);
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("no token → 401 without consuming it", async () => {
    const { nodeId } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth("nope"), ...octet }, body: "x" });
    expect(res.status).toBe(401);
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("another content type → 415 before claiming: it is neither read as JSON/text nor consumed", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    for (const type of ["application/json", "text/plain"]) {
      const res = await fetch(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), "content-type": type }, body: "{}" });
      expect(res.status).toBe(415);
      expect((await res.json()).error).toMatch(/Unsupported content type/);
    }
    expect(app.transfers.pendingCount).toBe(1);
  });

  it("no body or type → 415 and the transfer fails (nothing stays in progress)", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const res = await fetch(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: auth(nodeToken) });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/octet-stream/);
    await expect(t.incoming).rejects.toThrow();
    expect(app.transfers.pendingCount).toBe(0);
    expect(app.transfers.activeCount).toBe(0);
  });

  it("if the agent cuts off midway, the reader sees the error and the transfer leaves the registry", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const req = http.request(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet, "content-length": "1000" } });
    req.on("error", () => {});
    req.write(Buffer.alloc(100));
    const incoming = await t.incoming;
    const it = incoming.stream[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    req.destroy();
    await expect(it.next()).rejects.toThrow();
    await vi.waitFor(() => expect(app.transfers.activeCount).toBe(0));
  });

  it("cancel midway cuts the agent's request and the reader sees the cut", async () => {
    const { nodeId, nodeToken } = await enrollNode("nas");
    const t = app.transfers.inbound(nodeId);
    const req = http.request(`${url}/agent/transfer/${t.id}`, { method: "PUT", headers: { ...auth(nodeToken), ...octet, "content-length": "1000" } });
    const outcome = new Promise<string>((resolve) => {
      req.on("response", (res) => resolve(`response ${res.statusCode}`));
      req.on("error", () => resolve("cut"));
    });
    req.write(Buffer.alloc(100));
    const incoming = await t.incoming;
    const it = incoming.stream[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    t.cancel("test");
    expect(app.transfers.activeCount).toBe(0);
    await expect(it.next()).rejects.toThrow();
    expect(await outcome).toBe("cut");
  });
});

describe("contentLength", () => {
  const req = (v?: string) => ({ headers: v === undefined ? {} : { "content-length": v } }) as unknown as FastifyRequest;
  it("number or null", () => {
    expect(contentLength(req("0"))).toBe(0);
    expect(contentLength(req("1048576"))).toBe(1048576);
    expect(contentLength(req())).toBeNull();
    expect(contentLength(req("-1"))).toBeNull();
    expect(contentLength(req("12abc"))).toBeNull();
    expect(contentLength(req("99999999999999999999"))).toBeNull(); // outside the safe range
  });
});

describe("plugin: staging, sweeps and shutdown", () => {
  it("deletes the leftovers in <DATA_DIR>/staging from a previous run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcsm-panel-"));
    await mkdir(join(dataDir, "staging"));
    await writeFile(join(dataDir, "staging", "abandoned.part"), "half a file");
    const other = await buildApp({ db: openDb(":memory:"), config: { dataDir } });
    await other.ready();
    expect(await readdir(join(dataDir, "staging"))).toEqual([]);
    expect(other.staging.dir).toBe(join(dataDir, "staging"));
    await other.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("sweeps unclaimed transfers every 10 s and stops sweeping on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const other = await buildApp({ db: openDb(":memory:") });
      await other.ready();
      const t = other.transfers.outbound("n1", async () => ({ stream: Readable.from([]), size: 0 }));
      const sweep = vi.spyOn(other.transfers, "sweep");
      vi.advanceTimersByTime(50_000);
      expect(sweep).toHaveBeenCalledTimes(5);
      expect(other.transfers.pendingCount).toBe(1);
      vi.advanceTimersByTime(20_000); // 70 s > 60 s deadline
      expect(other.transfers.pendingCount).toBe(0);
      await expect(t.done).rejects.toMatchObject({ code: "expired" });
      await other.close();
      sweep.mockClear();
      vi.advanceTimersByTime(60_000);
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps the staging every hour with 24 h of age", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dataDir = await mkdtemp(join(tmpdir(), "mcsm-panel-"));
    try {
      const other = await buildApp({ db: openDb(":memory:"), config: { dataDir } });
      await other.ready();
      const dir = join(dataDir, "staging");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "viejo.bin"), "x");
      await writeFile(join(dir, "nuevo.bin"), "y");
      const old = new Date(Date.now() - 25 * 3600_000);
      await utimes(join(dir, "viejo.bin"), old, old);
      const sweep = vi.spyOn(other.staging, "sweep");
      vi.advanceTimersByTime(3600_000 - 1);
      expect(sweep).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenCalledWith(24 * 3600_000);
      expect(await sweep.mock.results[0]!.value).toBe(1);
      expect(await readdir(dir)).toEqual(["nuevo.bin"]);
      await other.close();
    } finally {
      vi.useRealTimers();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("on close it cancels what is pending", async () => {
    const other = await buildApp({ db: openDb(":memory:") });
    await other.ready();
    const out = other.transfers.outbound("n1", async () => ({ stream: Readable.from([]), size: 0 }));
    const inc = other.transfers.inbound("n1");
    await other.close();
    await expect(out.done).rejects.toMatchObject({ code: "cancelled" });
    await expect(inc.incoming).rejects.toMatchObject({ code: "cancelled" });
  });

  it("closing does not wait for a transfer in progress: it cuts it (preClose)", async () => {
    const other = await buildApp({ db: openDb(":memory:") });
    const otherUrl = await listen(other);
    const otherCookie = await setup(other);
    const t0 = (await other.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie: otherCookie }, payload: { nameHint: "nas" } })).json().token;
    const { nodeId, nodeToken } = (await other.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t0, nameHint: "nas", agentVersion: "fake" } })).json();
    const src = new PassThrough();
    const t = other.transfers.outbound(nodeId, async () => ({ stream: src, size: 1 << 20 }));
    src.write(Buffer.alloc(1024));
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(`${otherUrl}/agent/transfer/${t.id}`, { headers: auth(nodeToken) }, (r) => r.once("data", () => { r.pause(); resolve(r); }));
      req.on("error", reject);
    });
    const cut = cutShort(res);
    await other.close(); // without preClose it would be left waiting for the agent to finish
    expect(await cut).toBe(true);
    await expect(t.done).rejects.toMatchObject({ code: "cancelled" });
    expect(src.destroyed).toBe(true);
  });
});
