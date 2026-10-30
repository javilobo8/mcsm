import type { z } from "zod";
import { realTimers, type Timers } from "../files/stream.js";
import { UpstreamError } from "../versions/sources.js";

/**
 * HTTP client for the content sources (Modrinth, CurseForge): HTTPS only to allowlisted hosts, identifying
 * User-Agent, at most MAX_PER_HOST requests in flight per host, capped bodies and deadlines. `json` adds an
 * in-memory cache (LRU, per-call TTL, shared downloads, stale copy when the source fails) and validates every
 * document before storing it; `bytes` (packs, images) never caches.
 */

export type ContentFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "manual" },
) => Promise<Response>;

/** Modrinth asks for a User-Agent that identifies the client. */
export const CONTENT_USER_AGENT = "mc-server-manager (self-hosted; +https://github.com/javilobo8/mc-server-manager)";

export const API_HOSTS: ReadonlySet<string> = new Set(["api.modrinth.com", "api.curseforge.com"]);
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(["cdn.modrinth.com", "edge.forgecdn.net", "mediafilez.forgecdn.net"]);
export const IMAGE_HOSTS: ReadonlySet<string> = new Set(["cdn.modrinth.com", "media.forgecdn.net"]);

export const JSON_MAX_BYTES = 8 * 1024 * 1024;
export const API_TIMEOUT_MS = 10_000;
export const MAX_CACHE_ENTRIES = 1024;
export const MAX_PER_HOST = 8;

export const TOO_LARGE = "response too large";

/** Modrinth allows 300 requests a minute per IP: the panel keeps a margin for the browser-driven bursts. */
export const MODRINTH_REQUESTS_PER_MINUTE = 240;
/** Longest wait for a token of the budget; a request that would wait longer fails instead of hanging the page. */
export const RATE_BUDGET_MAX_WAIT_MS = 15_000;
export const RATE_BUDGET_EXHAUSTED = "rate budget exhausted";
export const DEFAULT_RATE_BUDGETS: Readonly<Record<string, number>> = { "api.modrinth.com": MODRINTH_REQUESTS_PER_MINUTE };

export interface UpstreamClientOptions {
  fetch?: ContentFetch;
  now?: () => number;
  timers?: Timers;
  /** Failure of a source (also when a stored copy is served): for the log. Gets the URL only, never headers. */
  onError?: (url: string, err: unknown) => void;
  /** Requests per minute per host (token bucket); hosts not listed are not budgeted. */
  rateBudgets?: Readonly<Record<string, number>>;
}

export interface JsonRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  ttlMs: number;
  /** Defaults to the URL; POSTs must pass one. Never include a secret in it. */
  cacheKey?: string;
}

export interface BytesOptions { hosts: ReadonlySet<string>; maxBytes: number; timeoutMs: number; maxRedirects: number }

interface Entry { doc: unknown; expiresAt: number }

/** The URL if it is HTTPS to one of `hosts`, else null. */
export function allowedUrl(url: string, hosts: ReadonlySet<string>): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.has(u.host) ? u : null;
  } catch {
    return null;
  }
}

/** FIFO of at most MAX_PER_HOST holders per host; a released slot passes straight to the next in line. */
class HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  async acquire(host: string): Promise<() => void> {
    const n = this.active.get(host) ?? 0;
    if (n < MAX_PER_HOST) this.active.set(host, n + 1);
    else await new Promise<void>((resolve) => {
      const q = this.waiting.get(host) ?? [];
      q.push(resolve);
      this.waiting.set(host, q);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(host);
    };
  }

  private release(host: string): void {
    const q = this.waiting.get(host);
    const next = q?.shift();
    if (q && q.length === 0) this.waiting.delete(host);
    if (next) { next(); return; }
    const n = (this.active.get(host) ?? 1) - 1;
    if (n <= 0) this.active.delete(host);
    else this.active.set(host, n);
  }
}

/**
 * Token bucket of `perMinute` requests (full at start). A request takes a token, possibly ahead of time: the balance may go
 * negative and each request waits until its own token is covered, so waiters are served in arrival order without a queue.
 */
class RateBudget {
  private tokens: number;
  private last: number;
  private readonly perMs: number;

  constructor(private readonly perMinute: number, private readonly now: () => number, private readonly timers: Timers) {
    this.tokens = perMinute;
    this.last = now();
    this.perMs = perMinute / 60_000;
  }

  async take(): Promise<void> {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + (t - this.last) * this.perMs);
    this.last = t;
    this.tokens -= 1;
    if (this.tokens >= 0) return;
    const wait = Math.ceil(-this.tokens / this.perMs);
    if (wait > RATE_BUDGET_MAX_WAIT_MS) {
      this.tokens += 1;
      throw new UpstreamError(null, RATE_BUDGET_EXHAUSTED);
    }
    await new Promise<void>((resolve) => { this.timers.set(resolve, wait); });
  }
}

export class UpstreamClient {
  private readonly cache = new Map<string, Entry>(); // insertion order: least to most recently used
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly limiter = new HostLimiter();
  private readonly budgets = new Map<string, RateBudget>();
  private readonly fetch: ContentFetch;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly onError: ((url: string, err: unknown) => void) | undefined;

  constructor(opts: UpstreamClientOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.onError = opts.onError;
    for (const [host, perMinute] of Object.entries(opts.rateBudgets ?? DEFAULT_RATE_BUDGETS)) {
      this.budgets.set(host, new RateBudget(perMinute, this.now, this.timers));
    }
  }

  async json<T>(req: JsonRequest, schema: z.ZodType<T>): Promise<{ data: T; stale: boolean }> {
    const method = req.method ?? "GET";
    if (method === "POST" && req.cacheKey === undefined) throw new Error("a POST needs a cacheKey");
    const key = `${method} ${req.cacheKey ?? req.url}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.touch(key, hit);
      return { data: hit.doc as T, stale: false };
    }
    try {
      return { data: (await this.shared(key, req, schema)) as T, stale: false };
    } catch (e) {
      this.onError?.(req.url, e);
      const old = this.cache.get(key);
      if (!old) throw e;
      this.touch(key, old);
      return { data: old.doc as T, stale: true };
    }
  }

  async bytes(url: string, opts: BytesOptions): Promise<{ data: Buffer; contentType: string }> {
    let current = allowedUrl(url, opts.hosts);
    if (!current) throw new UpstreamError(null, "origin not allowed");
    const ctrl = new AbortController();
    const cancel = this.timers.set(() => ctrl.abort(), opts.timeoutMs);
    try {
      for (let hops = 0; ; hops++) {
        await this.budgets.get(current.host)?.take();
        const release = await this.limiter.acquire(current.host);
        try {
          const res = await this.fetch(current.href, {
            method: "GET", signal: ctrl.signal, redirect: "manual", headers: { "user-agent": CONTENT_USER_AGENT },
          });
          if (res.status >= 300 && res.status < 400) {
            await discard(res);
            const location = res.headers.get("location");
            if (hops >= opts.maxRedirects) throw new UpstreamError(res.status, "too many redirects");
            const next: string | null = location === null ? null : safeResolve(location, current);
            if (!next || !allowedUrl(next, opts.hosts)) throw new UpstreamError(res.status, "redirect not allowed");
            current = new URL(next);
            continue;
          }
          if (!res.ok) {
            await discard(res);
            throw new UpstreamError(res.status, `HTTP ${res.status}`);
          }
          const data = await readCapped(res, opts.maxBytes);
          return { data, contentType: res.headers.get("content-type") ?? "" };
        } finally {
          release();
        }
      }
    } catch (e) {
      throw asUpstream(e, ctrl.signal);
    } finally {
      cancel();
    }
  }

  private shared(key: string, req: JsonRequest, schema: z.ZodType): Promise<unknown> {
    let p = this.inflight.get(key);
    if (!p) {
      p = this.download(req, schema)
        .then((doc) => {
          this.touch(key, { doc, expiresAt: this.now() + req.ttlMs });
          return doc;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private touch(key: string, entry: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async download(req: JsonRequest, schema: z.ZodType): Promise<unknown> {
    const url = allowedUrl(req.url, API_HOSTS);
    if (!url) throw new UpstreamError(null, "origin not allowed");
    const method = req.method ?? "GET";
    const headers: Record<string, string> = { ...req.headers, "user-agent": CONTENT_USER_AGENT, accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    const ctrl = new AbortController();
    await this.budgets.get(url.host)?.take();
    const release = await this.limiter.acquire(url.host);
    const cancel = this.timers.set(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await this.fetch(url.href, {
        method, headers, signal: ctrl.signal, redirect: "manual",
        ...(method === "POST" ? { body: JSON.stringify(req.body ?? null) } : {}),
      });
      if (res.status >= 300 && res.status < 400) {
        await discard(res);
        throw new UpstreamError(res.status, "redirect not allowed");
      }
      if (!res.ok) {
        await discard(res);
        throw new UpstreamError(res.status, `HTTP ${res.status}`);
      }
      const text = (await readCapped(res, JSON_MAX_BYTES)).toString("utf8");
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new UpstreamError(null, "invalid JSON");
      }
      // Validated before storing: a response with another shape is a failure of the source.
      const checked = schema.safeParse(doc);
      if (!checked.success) throw new UpstreamError(null, `unexpected response from ${url.host}`);
      return checked.data;
    } catch (e) {
      throw asUpstream(e, ctrl.signal);
    } finally {
      cancel();
      release();
    }
  }
}

function asUpstream(e: unknown, signal: AbortSignal): UpstreamError {
  if (e instanceof UpstreamError) return e;
  return new UpstreamError(null, signal.aborted ? "deadline exceeded" : "network error", { cause: e });
}

function safeResolve(location: string, base: URL): string | null {
  try {
    return new URL(location, base).href;
  } catch {
    return null;
  }
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await discard(res);
    throw new UpstreamError(null, TOO_LARGE);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError(null, TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
