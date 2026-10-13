import { finished, PassThrough, Transform, type Readable } from "node:stream";

/** Injectable timers: `set` arms one and returns the function that disarms it. */
export interface Timers {
  set(fn: () => void, ms: number): () => void;
}

export const realTimers: Timers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
};

/**
 * With not a single byte for this long, a transfer with the browser is considered dead: a
 * node that shuts down or a laptop that suspends do not always close the connection, and without a deadline
 * they would leave it open forever. It is twice the agent's watchdog (60 s), which usually
 * cuts first when it is the agent that stops reading or sending.
 */
export const IDLE_TIMEOUT_MS = 120_000;

/**
 * The most that is drained from the body of an upload that has already failed so that the browser
 * receives the error as JSON: cutting it off while it sends usually ends in "network error" instead of the
 * message. Beyond that it is not worth receiving (maybe GiB) just to throw it away: it responds with
 * `Connection: close` and closes.
 */
export const DRAIN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Wraps the body of a browser upload to hand it to the agent. If the agent cuts off,
 * the original body is not destroyed (it is detached and keeps being read), so that the browser
 * finishes sending and receives the error response instead of a network cut. If it is the
 * browser that cuts off, the copy is destroyed and the agent sees the transfer truncated.
 *
 * "The agent cuts off" includes `TransferService` cancelling the transfer: it destroys the copy
 * (without error) and the body keeps being drained all the same. A source already destroyed or finished (its
 * events already passed) gives a copy that fails at once, never one that keeps waiting.
 */
export function detachable(src: Readable): Readable {
  const out = new PassThrough();
  if (src.destroyed || src.readableEnded) {
    out.destroy(src.errored ?? new Error("The upload was interrupted"));
    return out;
  }
  src.on("error", (e) => out.destroy(e));
  src.on("close", () => { if (!src.readableEnded) out.destroy(new Error("The upload was interrupted")); });
  out.on("close", () => {
    if (!src.readableEnded) {
      src.unpipe(out);
      src.resume();
    }
  });
  src.pipe(out);
  return out;
}

/**
 * Intermediate step that watches a stream's inactivity: if `ms` pass without any chunk coming in,
 * it calls `onIdle` (which cuts whatever is needed) and destroys itself with the error it returns. The deadline
 * counts from creation, is re-armed with each chunk and is disarmed when the reader receives the
 * end or the guard is destroyed: a reader that stops reading after the last chunk also expires.
 */
export function idleGuard(ms: number, onIdle: () => Error, timers: Timers = realTimers): Transform {
  let disarm = () => {};
  const arm = () => {
    disarm();
    disarm = timers.set(() => guard.destroy(onIdle()), ms);
  };
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      arm();
      cb(null, chunk);
    },
    destroy(err, cb) {
      disarm();
      cb(err);
    },
  });
  guard.once("end", () => disarm());
  arm();
  return guard;
}

export interface DrainOptions {
  /** More than this without reaching the end: stop waiting (default DRAIN_MAX_BYTES). */
  maxBytes?: number;
  /** No data for this long: the body is destroyed (default IDLE_TIMEOUT_MS). */
  idleMs?: number;
  timers?: Timers;
}

/**
 * Reads and discards whatever remains of a body so a clean error can be returned. Returns
 * true if it reached its end and false if not: it exceeded `maxBytes` (the body keeps flowing and is
 * discarded until the connection closes), went silent for `idleMs` (destroyed) or failed.
 */
export function drain(body: Readable, opts: DrainOptions = {}): Promise<boolean> {
  if (body.readableEnded) return Promise.resolve(true);
  if (body.destroyed) return Promise.resolve(false);
  const { maxBytes = DRAIN_MAX_BYTES, idleMs = IDLE_TIMEOUT_MS, timers = realTimers } = opts;
  return new Promise((resolve) => {
    let n = 0;
    let settled = false;
    let disarm = () => {};
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      disarm();
      body.off("data", onData);
      stop();
      resolve(ok);
    };
    const arm = () => {
      disarm();
      disarm = timers.set(() => {
        done(false);
        body.destroy();
      }, idleMs);
    };
    const onData = (chunk: Buffer) => {
      n += chunk.length;
      if (n > maxBytes) done(false);
      else arm();
    };
    const stop = finished(body, (err) => done(!err && body.readableEnded));
    body.on("data", onData);
    arm();
    body.resume();
  });
}
