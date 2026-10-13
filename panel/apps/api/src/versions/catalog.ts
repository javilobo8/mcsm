import { BUILD_MESSAGES, VERSION_LIST_TYPES, VERSION_QUERY_RE, type BuildListDto, type VersionListDto, type VersionListType } from "@mcsm/shared";
import { realTimers, type Timers } from "../files/stream.js";
import { HttpError } from "../lib/http.js";
import { SOURCES, UpstreamError, allowedSource, type Get, type Source } from "./sources.js";

export const LIST_TTL_MS = 60 * 60_000;
export const BUILDS_TTL_MS = 15 * 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 256;
/** Fill v3 (PaperMC) pide un User-Agent que identifique al cliente. */
export const USER_AGENT = "mc-server-manager (self-hosted)";

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface CatalogOptions {
  fetch?: FetchFn;
  now?: () => number;
  timers?: Timers;
  /** Fallo de una fuente (también cuando se sirve lo guardado): para el log. */
  onError?: (url: string, err: unknown) => void;
}

interface Entry { doc: unknown; fetchedAt: number; expiresAt: number }

/**
 * Listas de versiones y builds de las fuentes oficiales con caché en memoria por URL de origen (spec
 * 2026-10-13-selector-versiones-design.md §4): listas 1 h, builds 15 min, como mucho MAX_ENTRIES
 * entradas (se descarta la menos usada). Consultas simultáneas a una URL comparten la descarga. Si la
 * fuente falla se sirve lo guardado con `stale: true`; sin nada guardado, 502.
 */
export class VersionCatalog {
  private readonly cache = new Map<string, Entry>(); // orden de inserción: de menos a más usada
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
    if (!VERSION_QUERY_RE.test(version)) throw new HttpError(400, "Versión inválida");
    const run = this.run();
    try {
      const builds = await src.builds(run.get, version);
      return { type, version, builds, fetchedAt: run.fetchedAt(), stale: run.stale() };
    } catch (e) {
      // La fuente no conoce esa versión (404; Fabric responde 400): no hay builds que elegir.
      if (e instanceof UpstreamError && e.status !== null && e.status >= 400 && e.status < 500) {
        return { type, version, builds: [], fetchedAt: new Date(this.now()).toISOString(), stale: false };
      }
      throw unavailable(src, e);
    }
  }

  private source(type: string): Source {
    if (!(VERSION_LIST_TYPES as readonly string[]).includes(type)) throw new HttpError(400, "Tipo sin lista de versiones");
    return SOURCES[type as VersionListType];
  }

  /** `get` de una consulta: anota si algo salió de lo guardado caducado y la descarga más antigua usada. */
  private run() {
    let stale = false;
    let oldest = Number.POSITIVE_INFINITY;
    const get: Get = async (url, opts = {}) => {
      const r = await this.cached(url, opts.kind ?? "json", opts.ttl === "builds" ? BUILDS_TTL_MS : LIST_TTL_MS);
      stale ||= r.stale;
      oldest = Math.min(oldest, r.entry.fetchedAt);
      return r.entry.doc;
    };
    return {
      get,
      stale: () => stale,
      fetchedAt: () => new Date(Number.isFinite(oldest) ? oldest : this.now()).toISOString(),
    };
  }

  private async cached(url: string, kind: "json" | "text", ttl: number): Promise<{ entry: Entry; stale: boolean }> {
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > this.now()) {
      this.touch(url, hit);
      return { entry: hit, stale: false };
    }
    try {
      return { entry: await this.shared(url, kind, ttl), stale: false };
    } catch (e) {
      this.onError?.(url, e);
      const old = this.cache.get(url);
      if (!old) throw e;
      this.touch(url, old);
      return { entry: old, stale: true };
    }
  }

  private shared(url: string, kind: "json" | "text", ttl: number): Promise<Entry> {
    let p = this.inflight.get(url);
    if (!p) {
      p = this.download(url, kind)
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

  /** La pone como la más usada y descarta las menos usadas por encima del tope. */
  private touch(url: string, entry: Entry): void {
    this.cache.delete(url);
    this.cache.set(url, entry);
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async download(url: string, kind: "json" | "text"): Promise<unknown> {
    if (!allowedSource(url)) throw new UpstreamError(null, "origen no permitido");
    const ctrl = new AbortController();
    const cancel = this.timers.set(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, accept: kind === "json" ? "application/json" : "text/html" },
      });
      if (!res.ok) throw new UpstreamError(res.status, `HTTP ${res.status}`);
      const text = await readCapped(res, MAX_BODY_BYTES);
      if (kind === "text") return text;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new UpstreamError(null, "JSON inválido");
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(null, ctrl.signal.aborted ? "plazo agotado" : "error de red");
    } finally {
      cancel();
    }
  }
}

function unavailable(src: Source, e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(502, `No se pudo consultar la lista de versiones de ${src.label}`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new UpstreamError(null, "respuesta demasiado grande");
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
      throw new UpstreamError(null, "respuesta demasiado grande");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
