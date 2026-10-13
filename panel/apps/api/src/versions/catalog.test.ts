import { describe, expect, it } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { UpstreamError } from "./sources.js";
import { BUILDS_TTL_MS, FETCH_TIMEOUT_MS, LIST_TTL_MS, MAX_BODY_BYTES, MAX_ENTRIES, VersionCatalog, type FetchFn } from "./catalog.js";

const PURPUR = "https://api.purpurmc.org/v2/purpur";
const purpurDoc = (versions: string[]) => JSON.stringify({ project: "purpur", versions });
const buildsDoc = (all: string[]) => JSON.stringify({ builds: { all } });
type Init = Parameters<FetchFn>[1];

/** Fake fetch: queued responses per URL; records each call. */
function fakeFetch() {
  const calls: ({ url: string } & Init)[] = [];
  const routes = new Map<string, ((init: Init) => Promise<Response>)[]>();
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift();
    return next ? next(init) : Promise.reject(new TypeError(`no network for ${url}`));
  };
  const reply = (url: string, body: string | ((init: Init) => Promise<Response>), status = 200) => {
    const q = routes.get(url) ?? [];
    q.push(typeof body === "function" ? body : () => Promise.resolve(new Response(body, { status })));
    routes.set(url, q);
  };
  return { fetch, calls, reply };
}

function setup() {
  let now = Date.parse("2026-10-13T10:00:00Z");
  const f = fakeFetch();
  const timers = new ManualTimers();
  const errors: string[] = [];
  const catalog = new VersionCatalog({ fetch: f.fetch, now: () => now, timers, onError: (url) => errors.push(url) });
  return { catalog, ...f, timers, errors, advance: (ms: number) => { now += ms; } };
}

describe("VersionCatalog", () => {
  it("stores the list for 1 h and requests it again on expiry", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["1.21.11", "26.2"]));
    expect(await t.catalog.versions("PURPUR")).toEqual({
      type: "PURPUR", versions: [{ id: "26.2", stable: true }, { id: "1.21.11", stable: true }],
      fetchedAt: "2026-10-13T10:00:00.000Z", stale: false,
    });
    expect(t.calls[0]!.headers["user-agent"]).toBe("mc-server-manager (self-hosted)");
    expect(t.timers.pending).toBe(0);
    t.advance(LIST_TTL_MS - 1);
    await t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    t.reply(PURPUR, purpurDoc(["26.3"]));
    t.advance(1);
    expect((await t.catalog.versions("PURPUR")).versions).toEqual([{ id: "26.3", stable: true }]);
    expect(t.calls).toHaveLength(2);
  });

  it("if the source fails it serves what is stored with stale; with nothing stored, 502 in English", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["26.2"]));
    await t.catalog.versions("PURPUR");
    t.advance(LIST_TTL_MS);
    t.reply(PURPUR, "down", 503);
    expect(await t.catalog.versions("PURPUR")).toMatchObject({ stale: true, fetchedAt: "2026-10-13T10:00:00.000Z", versions: [{ id: "26.2", stable: true }] });
    expect(t.errors).toEqual([PURPUR]);

    const t2 = setup();
    t2.reply(PURPUR, "down", 503);
    await expect(t2.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502, message: "Could not query the version list of Purpur" });
  });

  it("a 200 that is not the expected JSON is 502, not 500", async () => {
    const t = setup();
    t.reply(PURPUR, "<html>maintenance</html>");
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    t.reply(PURPUR, JSON.stringify({ otra: "shape" }));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("a 200 with another shape does not overwrite what is stored: the old list is served with stale and a warning is logged", async () => {
    const t = setup();
    t.reply(PURPUR, purpurDoc(["26.2"]));
    await t.catalog.versions("PURPUR");
    t.advance(LIST_TTL_MS);
    t.reply(PURPUR, JSON.stringify({ otra: "shape" }));
    expect(await t.catalog.versions("PURPUR")).toMatchObject({ stale: true, versions: [{ id: "26.2", stable: true }] });
    expect(t.errors).toEqual([PURPUR]);
  });

  it("with nothing stored, a 200 with another shape is 502 and is not stored: the next query goes back to the network", async () => {
    const t = setup();
    t.reply(PURPUR, "<html>maintenance</html>");
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    t.reply(PURPUR, JSON.stringify({ otra: "shape" }));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    expect(t.calls).toHaveLength(2);
    expect(t.errors).toEqual([PURPUR, PURPUR]);
    t.reply(PURPUR, purpurDoc(["26.2"]));
    expect((await t.catalog.versions("PURPUR")).versions).toEqual([{ id: "26.2", stable: true }]);
  });

  it("a redirect is not followed: 502 and the request goes with manual redirect", async () => {
    const t = setup();
    t.reply(PURPUR, () => Promise.resolve(new Response(null, { status: 302, headers: { location: "http://192.168.1.1/" } })));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    expect(t.calls[0]!.redirect).toBe("manual");
  });

  it("two simultaneous queries share the download", async () => {
    const t = setup();
    let release!: (r: Response) => void;
    t.reply(PURPUR, () => new Promise<Response>((r) => { release = r; }));
    const p1 = t.catalog.versions("PURPUR");
    const p2 = t.catalog.versions("PURPUR");
    expect(t.calls).toHaveLength(1);
    release(new Response(purpurDoc(["26.2"])));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.versions).toEqual(b.versions);
    expect(t.calls).toHaveLength(1);
  });

  it("10 s deadline: aborts the download and responds 502", async () => {
    const t = setup();
    t.reply(PURPUR, (init) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("deadline", "AbortError")));
    }));
    const p = t.catalog.versions("PURPUR");
    expect(t.timers.pending).toBe(1);
    t.timers.advance(FETCH_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ status: 502 });
    expect(t.timers.pending).toBe(0);
  });

  it("a response over 8 MiB is 502", async () => {
    const t = setup();
    t.reply(PURPUR, "x".repeat(MAX_BODY_BYTES + 1));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
  });

  it("builds: 15 min cache; a 4xx from the source is an empty list", async () => {
    const t = setup();
    const url = `${PURPUR}/26.2`;
    t.reply(url, buildsDoc(["2600", "2633"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds).toEqual([
      { id: "2633", stable: true, recommended: false }, { id: "2600", stable: true, recommended: false },
    ]);
    t.advance(BUILDS_TTL_MS);
    t.reply(url, buildsDoc(["2634"]));
    expect((await t.catalog.builds("PURPUR", "26.2")).builds[0]!.id).toBe("2634");
    t.reply(`${PURPUR}/9.9.9`, JSON.stringify({ error: "version not found" }), 404);
    expect(await t.catalog.builds("PURPUR", "9.9.9")).toMatchObject({ type: "PURPUR", version: "9.9.9", builds: [], stale: false });
  });

  it("only 400 and 404 from the source mean “no builds”: 429 and 403 are a failure (502)", async () => {
    const t = setup();
    t.reply(`${PURPUR}/1.0.1`, "slow down", 429);
    await expect(t.catalog.builds("PURPUR", "1.0.1")).rejects.toMatchObject({ status: 502 });
    t.reply(`${PURPUR}/1.0.2`, "no", 403);
    await expect(t.catalog.builds("PURPUR", "1.0.2")).rejects.toMatchObject({ status: 502 });
    t.reply(`${PURPUR}/1.0.3`, "bad", 400);
    expect((await t.catalog.builds("PURPUR", "1.0.3")).builds).toEqual([]);
  });

  it("a network failure keeps the original error as the cause", async () => {
    const seen: unknown[] = [];
    const f = fakeFetch();
    const catalog = new VersionCatalog({ fetch: f.fetch, timers: new ManualTimers(), onError: (_u, e) => seen.push(e) });
    const cause = new TypeError("getaddrinfo ENOTFOUND");
    f.reply(PURPUR, () => Promise.reject(cause));
    await expect(catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    expect(seen[0]).toBeInstanceOf(UpstreamError);
    expect((seen[0] as UpstreamError).cause).toBe(cause);
  });

  it("releases the unread body of an error response", async () => {
    const t = setup();
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    t.reply(PURPUR, () => Promise.resolve(new Response(body, { status: 500 })));
    await expect(t.catalog.versions("PURPUR")).rejects.toMatchObject({ status: 502 });
    expect(cancelled).toBe(true);
  });

  it("types without a list, types without builds and invalid versions: 400 without touching the network", async () => {
    const t = setup();
    await expect(t.catalog.versions("MODRINTH")).rejects.toMatchObject({ status: 400, message: "Type without a version list" });
    await expect(t.catalog.versions("__proto__")).rejects.toMatchObject({ status: 400 });
    await expect(t.catalog.builds("VANILLA", "1.21.4")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/VANILLA type does not support/) });
    for (const v of ["../../etc", "1.21 ", "\u0000", "a".repeat(65), ""]) {
      await expect(t.catalog.builds("PAPER", v)).rejects.toMatchObject({ status: 400, message: "Invalid version" });
    }
    expect(t.calls).toHaveLength(0);
  });

  it(`at most ${MAX_ENTRIES} entries: the least used is discarded`, async () => {
    const t = setup();
    const url = (i: number) => `${PURPUR}/1.0.${i}`;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      t.reply(url(i), buildsDoc([String(i)]));
      await t.catalog.builds("PURPUR", `1.0.${i}`);
    }
    await t.catalog.builds("PURPUR", "1.0.0"); // use: it becomes the most recent
    t.reply(url(MAX_ENTRIES), buildsDoc(["x"]));
    await t.catalog.builds("PURPUR", `1.0.${MAX_ENTRIES}`); // discards 1.0.1
    const before = t.calls.length;
    await t.catalog.builds("PURPUR", "1.0.0");
    expect(t.calls).toHaveLength(before);
    t.reply(url(1), buildsDoc(["1"]));
    await t.catalog.builds("PURPUR", "1.0.1");
    expect(t.calls).toHaveLength(before + 1);
  });
});
