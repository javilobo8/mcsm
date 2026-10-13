import { finished, pipeline, Transform, type Readable } from "node:stream";
import { finished as finishedAsync } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../lib/http.js";
import { hashToken } from "../lib/tokens.js";
import type { NodeRow } from "../nodes/repo.js";
import { TransferError, type TransferPayload } from "./service.js";

const NOT_FOUND = "Unknown, expired or already used transfer";
const CUT = "The transfer was cut off before finishing";

/** Request Content-Length, or null if absent (chunked body) or not a valid integer. */
export function contentLength(req: FastifyRequest): number | null {
  const v = req.headers["content-length"];
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Node that owns the Bearer token, or null. Same criterion as /agent/ws. */
function nodeFromAuth(app: FastifyInstance, req: FastifyRequest): NodeRow | null {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token ? app.nodes.findByTokenHash(hashToken(token)) : null;
}

const isReadable = (v: unknown): v is Readable => typeof (v as Readable | undefined)?.pipe === "function";

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Lets exactly `size` bytes of `src` through (the Content-Length announced to the agent). Fewer or
 * more is an error and the response is cut: the agent never receives a "complete" body that is not
 * the announced one. The chunk that completes the size is held back until the origin ends, so that
 * whatever arrives afterwards cannot pass as already delivered. If the copy is destroyed (the agent
 * left), `pipeline` also destroys the origin; if the origin fails, the copy fails with it.
 */
function exactly(src: Readable, size: number): Readable {
  let n = 0;
  let last: Buffer | undefined;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (chunk.length === 0) return cb();
      n += chunk.length;
      if (n > size) return cb(new Error(`the source sends more than the announced ${size} bytes`));
      if (n === size) {
        last = chunk;
        return cb();
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (n !== size) return cb(new Error(`the source sends ${n} of the announced ${size} bytes`));
      cb(null, last);
    },
  });
  pipeline(src, check, () => { /* the route sees the result in the response */ });
  return check;
}

/**
 * HTTP transfers of the agents (spec §5.1), outside the session guard and with the node's
 * token. The body is never loaded into memory: the stream is passed as is.
 *
 * Every claimed transfer ends in `complete`/`fail` (or in `deliver`, which releases it when
 * its body ends) through any exit, and its `signal` cuts the HTTP connection if it is cancelled.
 */
export async function transferRoutes(app: FastifyInstance) {
  // Authenticated node of each request in this context.
  const nodes = new WeakMap<FastifyRequest, NodeRow>();

  // Node token on EVERY request in this context, before reading the body. The hook belongs to
  // this encapsulated plugin: it runs on every route registered here and only on them, and Fastify gets
  // to them with the path already decoded (`/%61gent/transfer/x` is `/agent/transfer/:id`), so
  // no URL encoding skips it. Whatever does not route here is a 404 with no data.
  app.addHook("onRequest", async (req) => {
    const node = nodeFromAuth(app, req);
    if (!node) throw new HttpError(401, "invalid token");
    nodes.set(req, node);
  });

  // No body is interpreted (neither JSON nor text): only application/octet-stream, and as a
  // stream (req.body) with no size limit. Another type → 415 before reaching the route.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  // Panel → agent. No automatic HEAD route: a HEAD would consume the transfer.
  app.get<{ Params: { id: string } }>("/agent/transfer/:id", { exposeHeadRoute: false }, async (req, reply) => {
    const claimed = app.transfers.claim(req.params.id, nodes.get(req)!.id, "GET");
    if (claimed?.kind !== "outbound") throw new HttpError(404, NOT_FOUND);
    const res = reply.raw;
    let source: Readable | undefined;
    // What is sent: the origin, or its copy with the size checked if announced.
    let sent: Readable | undefined;

    // Cancelled (cancel/closeAll): the connection is cut and the agent sees the cut.
    const onAbort = () => res.destroy();
    claimed.signal.addEventListener("abort", onAbort, { once: true });
    // Every exit goes through here, also if the agent leaves before the origin is opened or if
    // the response was already closed. It only counts as delivered if what was sent reached its end
    // and the response finished: a 500 from an origin that fails before the first byte is not, nor is
    // an origin that delivers a different number of bytes than announced.
    finished(res, (err) => {
      claimed.signal.removeEventListener("abort", onAbort);
      if (!err && sent?.readableEnded) {
        claimed.complete();
      } else {
        sent?.destroy();
        source?.destroy();
        claimed.fail(new TransferError("aborted", CUT));
      }
    });

    let payload: TransferPayload;
    try {
      payload = await claimed.source();
    } catch (e) {
      const err = asError(e);
      claimed.fail(err);
      // The origin expired or was cancelled (e.g. another agent's PUT that feeds this GET): the
      // agent receives the reason. If it is this one that was cancelled, the connection is already cut.
      if (err instanceof TransferError) throw new HttpError(410, err.message);
      throw err; // the global handler logs it and responds 500 "Internal error"
    }
    // If the agent left while the origin was being opened, Fastify destroys the stream on seeing the
    // response already closed (and `fail` was already called above, in finished).
    source = payload.stream;
    sent = payload.size === null ? source : exactly(source, payload.size);
    reply.header("content-type", "application/octet-stream");
    if (payload.size !== null) reply.header("content-length", String(payload.size));
    return reply.send(sent);
  });

  // Agent → panel: the body is delivered to whoever waits and it responds once it has been read in full.
  app.put<{ Params: { id: string } }>("/agent/transfer/:id", async (req, reply) => {
    const claimed = app.transfers.claim(req.params.id, nodes.get(req)!.id, "PUT");
    if (claimed?.kind !== "inbound") throw new HttpError(404, NOT_FOUND);
    const body = req.body;
    if (!isReadable(body)) {
      // Only a PUT with no body and no Content-Type gets here.
      claimed.fail(new TransferError("aborted", "The agent did not send the transfer body"));
      throw new HttpError(415, "Send the body as application/octet-stream");
    }
    // Cancelled: the agent's request is cut (the service also destroys the body).
    const onAbort = () => req.raw.destroy();
    claimed.signal.addEventListener("abort", onAbort, { once: true });
    // In the same tick as the claim: nobody can cancel in between without deliver seeing it.
    claimed.deliver({ stream: body, size: contentLength(req) });
    try {
      await finishedAsync(body);
    } catch {
      claimed.fail(new TransferError("aborted", CUT));
      // The body was cut without being read in full (e.g. the panel rejected it midway): the connection cannot be reused,
      // and if not closed it would stay open waiting for the rest (and would hold back the panel's shutdown).
      reply.header("connection", "close");
      throw new HttpError(400, CUT);
    } finally {
      claimed.signal.removeEventListener("abort", onAbort);
    }
    return reply.code(204).send();
  });
}
