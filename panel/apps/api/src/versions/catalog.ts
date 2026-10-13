import { BUILD_MESSAGES, VERSION_LIST_TYPES, VERSION_QUERY_RE, type BuildListDto, type VersionListDto, type VersionListType } from "@mcsm/shared";
import type { z } from "zod";
import { realTimers, type Timers } from "../files/stream.js";
import { HttpError } from "../lib/http.js";
import { SOURCES, UpstreamError, allowedSource, type Get, type GetOptions, type Source } from "./sources.js";

export const LIST_TTL_MS = 60 * 60_000;
export const BUILDS_TTL_MS = 15 * 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 256;
/** Fill v3 (PaperMC) asks for a User-Agent that identifies the client. */
export const USER_AGENT = "mc-server-manager (self-hosted)";

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "manual" }) => Promise<Response>;

export interface CatalogOptions {
  fetch?: FetchFn;
  now?: () => number;
  timers?: Timers;
  /** Failure of a source (also when stored data is served): for the log. */
  onError?: (url: string, err: unknown) => void;
}

interface Entry { doc: unknown; fetchedAt: number; expiresAt: number }

/**
 * Lists of versions and builds from the official sources with an in-memory cache per origin URL (spec
 * 2026-10-13-version-selector-design.md §4): lists 1 h, builds 15 min, at most MAX_ENTRIES
 * entries (the least used is discarded). Simultaneous queries to a URL share the download. If the
 * source fails, what is stored is served with `stale: true`; with nothing stored, 502.
 */
export class VersionCatalog {
  private readonly cache = new Map<string, Entry>(); // insertion order: from least to most used
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly onError: ((url: string, err: unknown) => void) | undefined;

  constructor(opts: CatalogOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.onError = opts.onError;
  }

  async versions(type: string): Promise<VersionListDto> {
    const src = this.source(type);
    const run = this.run();
    try {
      const versions = await src.versions(run.get);
      return { type, versions, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      throw unavailable(src, e);
    }
  }

  async builds(type: string, version: string): Promise<BuildListDto> {
    const src = this.source(type);
    if (!src.builds) throw new HttpError(400, BUILD_MESSAGES.type(type));
    if (!VERSION_QUERY_RE.test(version)) throw new HttpError(400, "Invalid version");
    const run = this.run();
    try {
      const builds = await src.builds(run.get, version);
      return { type, version, builds, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      // The source does not know that version (404; Fabric responds 400): there are no builds to choose. Other 4xx
      // (401, 403, 429…) are a failure of the source, not an empty list.
      if (e instanceof UpstreamError && (e.status === 400 || e.status === 404)) {
        return { type, version, builds: [], fetchedAt: new Date(this.now()).toISOString(), stale: false };
      }
      throw unavailable(src, e);
    }
  }

  private source(type: string): Source {
    if (!(VERSION_LIST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Type without a version list");
    return SOURCES[type as VersionListType];
  }

  /** `get` of a query: notes whether anything came from expired stored data and the oldest download used. */
  private run() {
    let stale = false;
    let oldest = Number.POSITIVE_INFINITY;
    const get: Get = async <T>(url: string, schema: z.ZodType<T>, opts: GetOptions = {}) => {
      const r = await this.cached(url, schema, opts.kind ?? "json", opts.ttl === "builds" ? BUILDS_TTL_MS : LIST_TTL_MS);
      stale ||= r.stale;
      oldest = Math.min(oldest, r.entry.fetchedAt);
      return r.entry.doc as T;
    };
    return {
      get,
      stale: () => stale,
      fetchedAt: () => new Date(Number.isFinite(oldest) ? oldest : this.now()).toISOString(),
    };
  }

  private async cached(url: string, schema: z.ZodType, kind: "json" | "text", ttl: number): Promise<{ entry: Entry; stale: boolean }> {
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > this.now()) {
      this.touch(url, hit);
      return { entry: hit, stale: false };
    }
    try {
      return { entry: await this.shared(url, schema, kind, ttl), stale: false };
    } catch (e) {
      this.onError?.(url, e);
      const old = this.cache.get(url);
      if (!old) throw e;
      this.touch(url, old);
      return { entry: old, stale: true };
    }
  }

  private shared(url: string, schema: z.ZodType, kind: "json" | "text", ttl: number): Promise<Entry> {
    let p = this.inflight.get(url);
    if (!p) {
      p = this.download(url, schema, kind)
        .then((doc) => {
          const at = this.now();
          const entry: Entry = { doc, fetchedAt: at, expiresAt: at + ttl };
          this.touch(url, entry);
          return entry;
        })
        .finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  /** Makes it the most used and discards the least used above the cap. */
  private touch(url: string, entry: Entry): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async download(url: string, schema: z.ZodType, kind: "json" | "text"): Promise<unknown> {
    if (!allowedSource(url)) throw new UpstreamError(null, "origin not allowed");
    const ctrl = new AbortController();
    const cancel = this.timers.set(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: kind === "json" ? "application/json" : "text/html" },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new UpstreamError(res.status, "redirect not allowed");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new UpstreamError(res.status, `HTTP ${res.status}`);
      }
      const text = await readCapped(res, MAX_BODY_BYTES);
      let doc: unknown = text;
      if (kind === "json") {
        try {
          doc = JSON.parse(text);
        } catch {
          throw new UpstreamError(null, "invalid JSON");
        }
      }
      // It is validated before storing: a response with another shape is a failure of the source and does not overwrite what is stored.
      const checked = schema.safeParse(doc);
      if (!checked.success) throw new UpstreamError(null, `unexpected response from ${new URL(url).host}`);
      return checked.data;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(null, ctrl.signal.aborted ? "deadline exceeded" : "network error", { cause: e });
    } finally {
      cancel();
    }
  }
}

function unavailable(src: Source, e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(502, `Could not query the version list of ${src.label}`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new UpstreamError(null, "response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new UpstreamError(null, "response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
