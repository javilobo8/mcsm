import { describe, expect, it, vi } from "vitest";
import { ManualTimers } from "../../test/manual-timers.js";
import { fakeContentFetch } from "../../test/fake-content-fetch.js";
import { UpstreamClient } from "./http.js";
import { IMAGE_CACHE_BYTES, IMAGE_MAX_BYTES, IMAGE_TTL_MS, ImageProxy } from "./image.js";

const IMG = "https://cdn.modrinth.com/data/AANobbMI/icon.png";

function setup() {
  let now = Date.parse("2026-10-30T10:00:00Z");
  const f = fakeContentFetch();
  const http = new UpstreamClient({ fetch: f.fetch, now: () => now, timers: new ManualTimers() });
  return { ...f, proxy: new ImageProxy(http, () => now), advance: (ms: number) => { now += ms; } };
}
const png = (n = 4) => new Uint8Array(n).fill(7);

describe("ImageProxy", () => {
  it("refuses hosts outside the image allowlist without fetching", async () => {
    const t = setup();
    for (const url of ["https://evil.example/a.png", "http://cdn.modrinth.com/a.png", "https://edge.forgecdn.net/a.png", "javascript:alert(1)", ""]) {
      await expect(t.proxy.get(url)).rejects.toMatchObject({ status: 400, message: "Image host not allowed" });
    }
    expect(t.calls).toEqual([]);
  });

  it("serves allowed types without parameters", async () => {
    const t = setup();
    t.reply(IMG, png(), 200, { "content-type": "image/PNG; charset=binary" });
    const r = await t.proxy.get(IMG);
    expect(r.contentType).toBe("image/png");
    expect([...r.data]).toEqual([7, 7, 7, 7]);
    expect(t.calls[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("refuses SVG and other types", async () => {
    const t = setup();
    t.reply(IMG, "<svg/>", 200, { "content-type": "image/svg+xml" });
    await expect(t.proxy.get(IMG)).rejects.toMatchObject({ status: 502, message: "Unsupported image type" });
    t.reply(IMG, "<html/>", 200, { "content-type": "text/html" });
    await expect(t.proxy.get(IMG)).rejects.toMatchObject({ status: 502, message: "Unsupported image type" });
  });

  it("refuses images over 2 MiB", async () => {
    const t = setup();
    t.reply(IMG, png(IMAGE_MAX_BYTES + 1), 200, { "content-type": "image/png" });
    await expect(t.proxy.get(IMG)).rejects.toMatchObject({ status: 502, message: "Could not load the image" });
  });

  it("serves a second request from the cache until it expires", async () => {
    const t = setup();
    t.reply(IMG, png(), 200, { "content-type": "image/png" });
    await t.proxy.get(IMG);
    await t.proxy.get(IMG);
    expect(t.calls).toHaveLength(1);
    t.advance(IMAGE_TTL_MS);
    t.reply(IMG, png(), 200, { "content-type": "image/png" });
    await t.proxy.get(IMG);
    expect(t.calls).toHaveLength(2);
  });

  it("concurrent requests share one download", async () => {
    const t = setup();
    const h = t.hold(IMG);
    const a = t.proxy.get(IMG);
    const b = t.proxy.get(IMG);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    h.release(new Response(png(), { headers: { "content-type": "image/webp" } }));
    expect((await a).contentType).toBe("image/webp");
    expect((await b).contentType).toBe("image/webp");
    expect(t.calls).toHaveLength(1);
  });

  it("evicts the least recently used images beyond the byte budget", async () => {
    const t = setup();
    const size = IMAGE_MAX_BYTES; // 16 fit in 32 MiB
    const urls = Array.from({ length: IMAGE_CACHE_BYTES / size + 1 }, (_, i) => `https://media.forgecdn.net/a/${i}.png`);
    for (const u of urls) {
      t.reply(u, png(size), 200, { "content-type": "image/png" });
      await t.proxy.get(u);
    }
    t.reply(urls[0]!, png(), 200, { "content-type": "image/png" });
    await t.proxy.get(urls[0]!); // evicted: downloaded again
    await t.proxy.get(urls.at(-1)!); // still cached
    expect(t.calls).toHaveLength(urls.length + 1);
  });
});
