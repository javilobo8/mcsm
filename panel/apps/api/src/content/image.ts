import { HttpError } from "../lib/http.js";
import { API_TIMEOUT_MS, IMAGE_HOSTS, allowedUrl, type UpstreamClient } from "./http.js";

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TTL_MS = 24 * 3_600_000;
export const IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
/** Raster types only: SVG can carry scripts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

interface Image { data: Buffer; contentType: string }
interface Entry extends Image { expiresAt: number }

/**
 * Icons, gallery and description images of the content sources, served by the panel (the CSP keeps the browser on
 * 'self'): allowlisted CDNs over HTTPS, raster types, ≤ 2 MiB, cached in memory (LRU by bytes, 24 h).
 */
export class ImageProxy {
  private readonly cache = new Map<string, Entry>(); // least to most recently used
  private readonly inflight = new Map<string, Promise<Image>>();
  private bytes = 0;

  constructor(private readonly http: UpstreamClient, private readonly now: () => number) {}

  async get(url: string): Promise<Image> {
    if (!allowedUrl(url, IMAGE_HOSTS)) throw new HttpError(400, "Image host not allowed");
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > this.now()) {
      this.remove(url);
      this.store(url, hit);
      return { data: hit.data, contentType: hit.contentType };
    }
    let p = this.inflight.get(url);
    if (!p) {
      p = this.download(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  private async download(url: string): Promise<Image> {
    let r: { data: Buffer; contentType: string };
    try {
      r = await this.http.bytes(url, { hosts: IMAGE_HOSTS, maxBytes: IMAGE_MAX_BYTES, timeoutMs: API_TIMEOUT_MS, maxRedirects: 3 });
    } catch {
      throw new HttpError(502, "Could not load the image");
    }
    const contentType = (r.contentType.split(";")[0] ?? "").trim().toLowerCase();
    if (!(IMAGE_TYPES as readonly string[]).includes(contentType)) throw new HttpError(502, "Unsupported image type");
    this.remove(url);
    this.store(url, { data: r.data, contentType, expiresAt: this.now() + IMAGE_TTL_MS });
    return { data: r.data, contentType };
  }

  private store(url: string, e: Entry): void {
    this.cache.set(url, e);
    this.bytes += e.data.byteLength;
    while (this.bytes > IMAGE_CACHE_BYTES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(url: string): void {
    const e = this.cache.get(url);
    if (!e) return;
    this.cache.delete(url);
    this.bytes -= e.data.byteLength;
  }
}
