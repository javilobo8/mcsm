import type { ContentFetch } from "../src/content/http.js";

export type ContentInit = Parameters<ContentFetch>[1];
export interface ContentCall extends ContentInit { url: string }
type Handler = (init: ContentInit) => Promise<Response>;

/** Fake fetch for the content sources: queued responses per URL (method-agnostic); records each call. */
export function fakeContentFetch() {
  const calls: ContentCall[] = [];
  const routes = new Map<string, Handler[]>();
  const fetch: ContentFetch = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift();
    return next ? next(init) : Promise.reject(new TypeError(`no network for ${url}`));
  };
  /** Queues one response for `url`: a JSON value (serialised), a raw string/bytes, or a handler. */
  const reply = (url: string, body: Handler | string | Uint8Array | object | number | boolean | null, status = 200, headers: Record<string, string> = {}) => {
    const q = routes.get(url) ?? [];
    if (typeof body === "function") q.push(body as Handler);
    else {
      const payload = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
      q.push(() => Promise.resolve(new Response(payload as BodyInit, { status, headers })));
    }
    routes.set(url, q);
  };
  /** Queues a response that stays pending until `release` is called. */
  const hold = (url: string) => {
    let release!: (r: Response) => void;
    let fail!: (e: unknown) => void;
    reply(url, () => new Promise<Response>((res, rej) => { release = res; fail = rej; }));
    return { release: (r: Response) => release(r), fail: (e: unknown) => fail(e) };
  };
  return { fetch, calls, reply, hold };
}
