import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { UpstreamError } from "../versions/sources.js";
import { API_TIMEOUT_MS, CONTENT_USER_AGENT, DOWNLOAD_HOSTS, JSON_MAX_BYTES, MAX_PER_HOST, MODRINTH_REQUESTS_PER_MINUTE, RATE_BUDGET_EXHAUSTED, RATE_BUDGET_MAX_WAIT_MS, UpstreamClient } from "./http.js";

const URL1 = "https://api.modrinth.com/v2/project/AABBCCDD";
const doc = z.object({ id: z.string() });

function setup(rateBudgets?: Record<string, number>) {
  let now = Date.parse("2026-10-30T10:00:00Z");
  const f = fakeContentFetch();
  const timers = new ManualTimers();
  const errors: string[] = [];
  const client = new UpstreamClient({ fetch: f.fetch, now: () => now, timers, onError: (url) => errors.push(url), rateBudgets });
  return { client, ...f, timers, errors, advance: (ms: number) => { now += ms; } };
}

describe("UpstreamClient.json", () => {
  it("caches a GET for its ttl and refetches after it", async () => {
    const t = setup();
    t.reply(URL1, { id: "a" });
    expect(await t.client.json({ url: URL1, ttlMs: 60_000 }, doc)).toEqual({ data: { id: "a" }, stale: false });
    expect(t.calls[0]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(t.calls[0]!.headers).toMatchObject({ "user-agent": CONTENT_USER_AGENT, accept: "application/json" });
    expect(t.calls[0]!.headers["content-type"]).toBeUndefined();
    await t.client.json({ url: URL1, ttlMs: 60_000 }, doc);
    expect(t.calls).toHaveLength(1);
    t.advance(60_001);
    t.reply(URL1, { id: "b" });
    expect((await t.client.json({ url: URL1, ttlMs: 60_000 }, doc)).data).toEqual({ id: "b" });
    expect(t.calls).toHaveLength(2);
    expect(t.timers.pending).toBe(0);
  });

  it("POST is cached by cacheKey, never by url", async () => {
    const t = setup();
    const url = "https://api.modrinth.com/v2/version_files";
    t.reply(url, { id: "a" });
    t.reply(url, { id: "b" });
    const a = await t.client.json({ url, method: "POST", body: { hashes: ["1"] }, cacheKey: "k1", ttlMs: 60_000 }, doc);
    const b = await t.client.json({ url, method: "POST", body: { hashes: ["2"] }, cacheKey: "k2", ttlMs: 60_000 }, doc);
    const a2 = await t.client.json({ url, method: "POST", body: { hashes: ["1"] }, cacheKey: "k1", ttlMs: 60_000 }, doc);
    expect([a.data.id, b.data.id, a2.data.id]).toEqual(["a", "b", "a"]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]).toMatchObject({ method: "POST", body: JSON.stringify({ hashes: ["1"] }) });
    expect(t.calls[0]!.headers["content-type"]).toBe("application/json");
    await expect(t.client.json({ url, method: "POST", body: {}, ttlMs: 1 }, doc)).rejects.toThrow(/cacheKey/);
  });

  it("shares one download between concurrent callers", async () => {
    const t = setup();
    const h = t.hold(URL1);
    const p1 = t.client.json({ url: URL1, ttlMs: 60_000 }, doc);
    const p2 = t.client.json({ url: URL1, ttlMs: 60_000 }, doc);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    h.release(new Response(JSON.stringify({ id: "a" })));
    expect((await p1).data).toEqual((await p2).data);
    expect(t.calls).toHaveLength(1);
  });

  it("serves the stored copy with stale: true when the source fails", async () => {
    const t = setup();
    t.reply(URL1, { id: "a" });
    await t.client.json({ url: URL1, ttlMs: 60_000 }, doc);
    t.advance(60_001);
    t.reply(URL1, () => Promise.reject(new TypeError("down")));
    expect(await t.client.json({ url: URL1, ttlMs: 60_000 }, doc)).toEqual({ data: { id: "a" }, stale: true });
    expect(t.errors).toEqual([URL1]);

    const t2 = setup();
    t2.reply(URL1, "down", 503);
    await expect(t2.client.json({ url: URL1, ttlMs: 60_000 }, doc)).rejects.toMatchObject({ name: "UpstreamError", status: 503 });
  });

  it("rejects a body with another shape and keeps the cached one", async () => {
    const t = setup();
    t.reply(URL1, { id: "a" });
    await t.client.json({ url: URL1, ttlMs: 60_000 }, doc);
    t.advance(60_001);
    t.reply(URL1, { oops: 1 });
    expect(await t.client.json({ url: URL1, ttlMs: 60_000 }, doc)).toEqual({ data: { id: "a" }, stale: true });
    t.reply(URL1, { id: "c" });
    expect((await t.client.json({ url: URL1, ttlMs: 60_000 }, doc)).data).toEqual({ id: "c" });

    const t2 = setup();
    t2.reply(URL1, "<html>maintenance</html>");
    await expect(t2.client.json({ url: URL1, ttlMs: 60_000 }, doc)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("refuses hosts outside the allowlist without fetching", async () => {
    const t = setup();
    for (const url of ["https://evil.example/x", "http://api.modrinth.com/v2/x", "https://cdn.modrinth.com/x", "not a url"]) {
      await expect(t.client.json({ url, ttlMs: 1 }, doc)).rejects.toMatchObject({ name: "UpstreamError", message: "origin not allowed" });
    }
    expect(t.calls).toEqual([]);
  });

  it("refuses redirects on JSON", async () => {
    const t = setup();
    t.reply(URL1, () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://api.modrinth.com/v2/y" } })));
    await expect(t.client.json({ url: URL1, ttlMs: 1 }, doc)).rejects.toMatchObject({ name: "UpstreamError", status: 302 });
    expect(t.calls).toHaveLength(1);
  });

  it("caps the body at 8 MiB", async () => {
    const t = setup();
    t.reply(URL1, "{}", 200, { "content-length": String(JSON_MAX_BYTES + 1) });
    await expect(t.client.json({ url: URL1, ttlMs: 1 }, doc)).rejects.toMatchObject({ message: "response too large" });
    t.reply(URL1, () => Promise.resolve(new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(JSON_MAX_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); },
    }))));
    await expect(t.client.json({ url: URL1, ttlMs: 1 }, doc)).rejects.toMatchObject({ message: "response too large" });
  });

  it("aborts after 10 s", async () => {
    const t = setup();
    t.reply(URL1, (init) => new Promise<Response>((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))));
    const p = t.client.json({ url: URL1, ttlMs: 1 }, doc);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.timers.pending).toBe(1);
    t.timers.advance(API_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ name: "UpstreamError", message: "deadline exceeded" });
  });

  it("runs at most 8 requests per host at once", async () => {
    const t = setup();
    const held = Array.from({ length: MAX_PER_HOST + 1 }, (_, i) => t.hold(`${URL1}/${i}`));
    const ps = held.map((_, i) => t.client.json({ url: `${URL1}/${i}`, ttlMs: 1 }, doc));
    await vi.waitFor(() => expect(t.calls).toHaveLength(MAX_PER_HOST));
    // Another host is not held back by the full one.
    t.reply("https://api.curseforge.com/v1/x", { id: "cf" });
    expect((await t.client.json({ url: "https://api.curseforge.com/v1/x", ttlMs: 1 }, doc)).data.id).toBe("cf");
    held[0]!.release(new Response(JSON.stringify({ id: "0" })));
    await ps[0];
    await vi.waitFor(() => expect(t.calls).toHaveLength(MAX_PER_HOST + 2));
    expect(t.calls.at(-1)!.url).toBe(`${URL1}/${MAX_PER_HOST}`);
    held.slice(1).forEach((h, i) => h.release(new Response(JSON.stringify({ id: String(i) }))));
    await Promise.all(ps);
  });
});

describe("UpstreamClient rate budget", () => {
  const get = (t: ReturnType<typeof setup>, i: number) => t.client.json({ url: `${URL1}/${i}`, ttlMs: 1 }, doc);

  it("spends at most 240 requests a minute on api.modrinth.com by default", async () => {
    const t = setup();
    t.replyWhen((u) => u.host === "api.modrinth.com", { id: "x" });
    expect(MODRINTH_REQUESTS_PER_MINUTE).toBe(240);
    await Promise.all(Array.from({ length: MODRINTH_REQUESTS_PER_MINUTE }, (_, i) => get(t, i)));
    const late = get(t, 999);
    await vi.waitFor(() => expect(t.timers.pending).toBe(1)); // waiting for a token, not fetching
    expect(t.calls).toHaveLength(MODRINTH_REQUESTS_PER_MINUTE);
    // Other hosts are not budgeted.
    t.reply("https://api.curseforge.com/v1/x", { id: "cf" });
    await t.client.json({ url: "https://api.curseforge.com/v1/x", ttlMs: 1 }, doc);
    t.advance(250);
    t.timers.advance(250); // 60 000 / 240 ms: one token back
    await late;
    expect(t.calls).toHaveLength(MODRINTH_REQUESTS_PER_MINUTE + 2);
  });

  it("queues in order and fails a request whose wait would exceed the bound", async () => {
    const t = setup({ "api.modrinth.com": 2 }); // one token every 30 s
    t.replyWhen((u) => u.host === "api.modrinth.com", { id: "x" });
    await get(t, 1);
    await get(t, 2);
    expect(RATE_BUDGET_MAX_WAIT_MS).toBeLessThan(30_000);
    await expect(get(t, 3)).rejects.toMatchObject({ name: "UpstreamError", status: null, message: RATE_BUDGET_EXHAUSTED });
    expect(t.calls).toHaveLength(2);
    t.advance(30_000);
    await get(t, 4); // the refused request gave its token back
    expect(t.calls).toHaveLength(3);
  });

  it("a budget of 60 a minute paces a burst one second apart", async () => {
    const t = setup({ "api.modrinth.com": 60 });
    t.replyWhen((u) => u.host === "api.modrinth.com", { id: "x" });
    await Promise.all(Array.from({ length: 60 }, (_, i) => get(t, i)));
    const a = get(t, 100);
    const b = get(t, 101);
    await vi.waitFor(() => expect(t.timers.pending).toBe(2));
    t.advance(1_000); t.timers.advance(1_000);
    await a;
    expect(t.calls).toHaveLength(61);
    t.advance(1_000); t.timers.advance(1_000);
    await b;
    expect(t.calls).toHaveLength(62);
  });
});

describe("UpstreamClient.bytes", () => {
  const opts = { hosts: DOWNLOAD_HOSTS, maxBytes: 1024, timeoutMs: 60_000, maxRedirects: 3 };

  it("bytes follows a redirect inside the allowlist and refuses one outside", async () => {
    const t = setup();
    const edge = "https://edge.forgecdn.net/files/1/2/pack.zip";
    const media = "https://mediafilez.forgecdn.net/files/1/2/pack.zip";
    t.reply(edge, () => Promise.resolve(new Response(null, { status: 302, headers: { location: media } })));
    t.reply(media, "zip-bytes", 200, { "content-type": "application/zip" });
    const r = await t.client.bytes(edge, opts);
    expect(r.data.toString()).toBe("zip-bytes");
    expect(r.contentType).toBe("application/zip");
    expect(t.calls.map((c) => c.url)).toEqual([edge, media]);

    t.reply(edge, () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.com/" } })));
    await expect(t.client.bytes(edge, opts)).rejects.toMatchObject({ message: "redirect not allowed" });
    expect(t.calls).toHaveLength(3);
  });

  it("resolves a relative location against the current URL", async () => {
    const t = setup();
    const a = "https://cdn.modrinth.com/data/a/x.mrpack";
    t.reply(a, () => Promise.resolve(new Response(null, { status: 301, headers: { location: "/data/b/y.mrpack" } })));
    t.reply("https://cdn.modrinth.com/data/b/y.mrpack", "ok");
    expect((await t.client.bytes(a, opts)).data.toString()).toBe("ok");
  });

  it("stops after maxRedirects and refuses hosts outside the list without fetching", async () => {
    const t = setup();
    const a = "https://cdn.modrinth.com/a";
    for (let i = 0; i < 2; i++) t.reply(a, () => Promise.resolve(new Response(null, { status: 302, headers: { location: a } })));
    await expect(t.client.bytes(a, { ...opts, maxRedirects: 1 })).rejects.toMatchObject({ message: "too many redirects" });
    expect(t.calls).toHaveLength(2);
    await expect(t.client.bytes("https://api.modrinth.com/x", opts)).rejects.toMatchObject({ message: "origin not allowed" });
    await expect(t.client.bytes("http://cdn.modrinth.com/x", opts)).rejects.toMatchObject({ message: "origin not allowed" });
    expect(t.calls).toHaveLength(2);
  });

  it("caps the size by content-length and while streaming, and never caches", async () => {
    const t = setup();
    const a = "https://cdn.modrinth.com/a";
    t.reply(a, "x", 200, { "content-length": "1025" });
    await expect(t.client.bytes(a, opts)).rejects.toMatchObject({ message: "response too large" });
    t.reply(a, "y".repeat(1025));
    await expect(t.client.bytes(a, opts)).rejects.toMatchObject({ message: "response too large" });
    t.reply(a, "z");
    t.reply(a, "z");
    await t.client.bytes(a, opts);
    await t.client.bytes(a, opts);
    expect(t.calls).toHaveLength(4);
  });

  it("aborts after its own timeout", async () => {
    const t = setup();
    const a = "https://cdn.modrinth.com/a";
    t.reply(a, (init) => new Promise<Response>((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))));
    const p = t.client.bytes(a, { ...opts, timeoutMs: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.timers.pending).toBe(1);
    t.timers.advance(5);
    await expect(p).rejects.toMatchObject({ message: "deadline exceeded" });
  });
});
