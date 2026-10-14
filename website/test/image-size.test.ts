import path from "node:path";
import { describe, expect, it } from "vitest";
import { webpSize } from "../build/docs/image-size";
import { compileDoc } from "../build/docs/compile";

function riff(chunk: string, payload: number[]): Uint8Array {
  const body = [...Buffer.from("WEBP"), ...Buffer.from(chunk), payload.length, 0, 0, 0, ...payload];
  return Uint8Array.from([...Buffer.from("RIFF"), body.length & 0xff, 0, 0, 0, ...body]);
}

describe("webpSize", () => {
  it("reads a lossy (VP8) image", () => {
    // frame tag, start code, 1440 (0x05a0) x 900 (0x0384)
    expect(webpSize(riff("VP8 ", [0x90, 0xb7, 0x02, 0x9d, 0x01, 0x2a, 0xa0, 0x05, 0x84, 0x03]))).toEqual({ width: 1440, height: 900 });
  });
  it("reads a lossless (VP8L) image", () => {
    // signature 0x2f, then 14 bits width-1 and 14 bits height-1: 100x50
    const w = 99, h = 49;
    const bits = w | (h << 14);
    expect(webpSize(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]))).toEqual({ width: 100, height: 50 });
  });
  it("reads an extended (VP8X) image", () => {
    // flags + 3 reserved, then 24-bit width-1 and height-1: 1200x630
    expect(webpSize(riff("VP8X", [0, 0, 0, 0, 0xaf, 0x04, 0x00, 0x75, 0x02, 0x00]))).toEqual({ width: 1200, height: 630 });
  });
  it("returns undefined for anything else", () => {
    expect(webpSize(Uint8Array.from(Buffer.from("not an image at all, really")))).toBeUndefined();
  });
});

describe("compileDoc image sizes", () => {
  it("adds width and height when the size is known", async () => {
    const d = await compileDoc("![Backups](/screenshots/06-backups.webp)\n", {
      base: "/mcsm/",
      repoRoot: path.join(__dirname, "fixtures/repo"),
      imageSize: (src) => (src === "/screenshots/06-backups.webp" ? { width: 1440, height: 900 } : undefined),
    });
    expect(d.html).toMatch(/<img[^>]*width="1440"[^>]*height="900"/);
  });
});
