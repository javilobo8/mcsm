import type { ContentFetch } from "../src/content/http.js";

export type ContentInit = Parameters<ContentFetch>[1];
export interface ContentCall extends ContentInit { url: string }
type Handler = (init: ContentInit, url: string) => Promise<Response>;

/** Fake fetch for the content sources: queued responses per URL (method-agnostic); records each call. */
export function fakeContentFetch() {
  const calls: ContentCall[] = [];
  const routes = new Map<string, Handler[]>();
  const matchers: { match: (u: URL, init: ContentInit) => boolean; handler: Handler }[] = [];
  const fetch: ContentFetch = (url, init) => {
    calls.push({ url, ...init });
    const next = routes.get(url)?.shift() ?? matchers.find((m) => m.match(new URL(url), init))?.handler;
    return next ? next(init, url) : Promise.reject(new TypeError(`no network for ${url}`));
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
  /** Answers every request that `match` accepts (after the queued ones) with a JSON value, or one computed from the request. */
  const replyWhen = (
    match: (u: URL, init: ContentInit) => boolean,
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) => {
    matchers.push({
      match,
      handler: (init, url) => {
        const v = typeof body === "function" ? (body as (u: URL, init: ContentInit) => unknown)(new URL(url), init) : body;
        return Promise.resolve(new Response(typeof v === "string" ? v : JSON.stringify(v), { status, headers }));
      },
    });
  };
  /** Queues a response that stays pending until `release` is called. */
  const hold = (url: string) => {
    let release!: (r: Response) => void;
    let fail!: (e: unknown) => void;
    reply(url, () => new Promise<Response>((res, rej) => { release = res; fail = rej; }));
    return { release: (r: Response) => release(r), fail: (e: unknown) => fail(e) };
  };
  return { fetch, calls, reply, replyWhen, hold };
}
