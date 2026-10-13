import { finished, type Readable } from "node:stream";
import { randomToken } from "../lib/tokens.js";

/** Body of a transfer: stream and size (null if unknown). */
export interface TransferPayload { stream: Readable; size: number | null }
/** Lazy source of a panel → agent transfer: invoked when the agent does the GET. */
export type TransferSource = () => Promise<TransferPayload>;

export type TransferErrorCode = "expired" | "cancelled" | "aborted";

export class TransferError extends Error {
  constructor(public code: TransferErrorCode, message: string) { super(message); this.name = "TransferError"; }
}

/** Panel → agent: the agent does GET /agent/transfer/:id. */
export interface OutboundTransfer {
  id: string;
  /** Resolves when the agent has received the whole body; rejects if it expires, is cancelled or is cut. */
  done: Promise<void>;
  /**
   * Unclaimed: invalidates it and rejects `done`. In progress: also aborts the route's `signal` and
   * destroys the source's stream. Already finished: does nothing.
   */
  cancel(reason?: string): void;
}

/** Agent → panel: the agent does PUT /agent/transfer/:id. */
export interface InboundTransfer {
  id: string;
  /** Resolves when the agent's PUT arrives, with its body streaming. */
  incoming: Promise<TransferPayload>;
  /**
   * Unclaimed: invalidates it and rejects `incoming`. In progress: also aborts the route's `signal`
   * and destroys the delivered body (whoever reads it sees the cut). Already finished: does nothing.
   */
  cancel(reason?: string): void;
}

/**
 * What the HTTP route gets on claiming a transferId. `signal` is aborted (with a
 * TransferError "cancelled") if the transfer is cancelled or the panel shuts down with it in
 * progress: the route must link it to its HTTP request/response and cut it.
 * - outbound: `complete()` when delivered in full; `fail(err)` on any other exit.
 * - inbound: `deliver(payload)` with the body; leaves the registry when that stream ends.
 *   `fail(err)` if the route cannot deliver it.
 */
export type ClaimedTransfer =
  | { kind: "outbound"; signal: AbortSignal; source: TransferSource; complete(): void; fail(err: Error): void }
  | { kind: "inbound"; signal: AbortSignal; deliver(payload: TransferPayload): void; fail(err: Error): void };

interface Deferred<T> { promise: Promise<T>; settled: boolean; resolve(v: T): void; reject(e: Error): void }

function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { res = a; rej = b; });
  promise.catch(() => {}); // whoever does not await it does not cause an unhandledRejection
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => { if (!d.settled) { d.settled = true; res(v); } },
    reject: (e) => { if (!d.settled) { d.settled = true; rej(e); } },
  };
  return d;
}

type Entry =
  | { kind: "outbound"; nodeId: string; createdAt: number; ttl: number; source: TransferSource; done: Deferred<void> }
  | { kind: "inbound"; nodeId: string; createdAt: number; ttl: number; incoming: Deferred<TransferPayload> };

/** Options of a specific transfer. */
export interface TransferOptions {
  /**
   * Deadline to claim it (by default, the service's: 60 s). Migration between nodes lengthens it: the target
   * claims the backup when one of its backup/restore slots comes up, and may wait in a queue.
   */
  claimTtlMs?: number;
}

/** Transfer claimed and still in progress. */
interface Active { entry: Entry; controller: AbortController; stream?: Readable }

export interface TransferServiceOptions {
  /** Injectable clock (ms). */
  now?: () => number;
  /** Time the agent has to claim the transfer. */
  claimTtlMs?: number;
}

const EXPIRED = "The agent did not start the transfer in time";
const CLOSING = "the panel is shutting down";

/**
 * HTTP transfers between panel and agents (spec §5.1). Each transferId is random
 * (32 bytes), single use, bound to the node that must claim it and expires if nobody
 * claims it in time. The body is never loaded into memory: streams are passed.
 *
 * The deadline only covers the claim (how long the agent takes to do the GET/PUT); the duration
 * of the transfer itself is watched by the HTTP route and whoever requested it. Claimed ones stay in
 * a registry of transfers in progress until they finish, so that `cancel` and `closeAll`
 * can cut them.
 */
export class TransferService {
  private pending = new Map<string, Entry>();
  private active = new Map<string, Active>();
  private now: () => number;
  private ttl: number;
  private closed = false;

  constructor(opts: TransferServiceOptions = {}) {
    this.now = opts.now ?? (() => Date.now()); // read at call time: tests can fake Date
    this.ttl = opts.claimTtlMs ?? 60_000;
  }

  /** Transfers not yet claimed. */
  get pendingCount(): number { return this.pending.size; }

  /** Transfers claimed that have not finished yet. */
  get activeCount(): number { return this.active.size; }

  outbound(nodeId: string, source: TransferSource, opts: TransferOptions = {}): OutboundTransfer {
    const id = randomToken();
    const done = deferred<void>();
    this.add(id, { kind: "outbound", nodeId, createdAt: this.now(), ttl: opts.claimTtlMs ?? this.ttl, source, done });
    return { id, done: done.promise, cancel: (reason = "cancelled") => this.cancel(id, reason) };
  }

  inbound(nodeId: string, opts: TransferOptions = {}): InboundTransfer {
    const id = randomToken();
    const incoming = deferred<TransferPayload>();
    this.add(id, { kind: "inbound", nodeId, createdAt: this.now(), ttl: opts.claimTtlMs ?? this.ttl, incoming });
    return { id, incoming: incoming.promise, cancel: (reason = "cancelled") => this.cancel(id, reason) };
  }

  /**
   * Claims a transferId (single use). Returns null without consuming it if it belongs to another node or the
   * other direction (a node cannot burn foreign transfers), and null consuming it if it expired.
   */
  claim(id: string, nodeId: string, method: "GET" | "PUT"): ClaimedTransfer | null {
    const e = this.pending.get(id);
    if (!e || e.nodeId !== nodeId) return null;
    if ((method === "GET") !== (e.kind === "outbound")) return null;
    this.pending.delete(id);
    if (this.expired(e)) {
      this.reject(e, new TransferError("expired", EXPIRED));
      return null;
    }
    const a: Active = { entry: e, controller: new AbortController() };
    this.active.set(id, a);
    const signal = a.controller.signal;

    if (e.kind === "outbound") {
      return {
        kind: "outbound",
        signal,
        source: async () => {
          signal.throwIfAborted(); // cancelled before the effective GET: the source is not opened
          const p = await e.source();
          if (signal.aborted) {
            p.stream.destroy(); // cancelled while it was opening
            signal.throwIfAborted();
          }
          a.stream = p.stream;
          return p;
        },
        complete: () => { this.release(id, a); e.done.resolve(); },
        fail: (err) => { this.release(id, a); e.done.reject(err); },
      };
    }
    return {
      kind: "inbound",
      signal,
      deliver: (p) => {
        if (signal.aborted || e.incoming.settled) {
          p.stream.destroy(); // nobody will read it: so the agent's PUT is not left waiting
          return;
        }
        a.stream = p.stream;
        finished(p.stream, () => this.release(id, a));
        e.incoming.resolve(p);
      },
      fail: (err) => { this.release(id, a); e.incoming.reject(err); },
    };
  }

  /** Expires the transfers not claimed in time. Returns how many. */
  sweep(): number {
    let n = 0;
    for (const [id, e] of this.pending) {
      if (!this.expired(e)) continue;
      this.pending.delete(id);
      this.reject(e, new TransferError("expired", EXPIRED));
      n++;
    }
    return n;
  }

  /**
   * Panel shutdown: cancels what is pending and aborts what is in progress (rejects their promises,
   * aborts their route's signal and destroys their streams). Whatever is requested afterwards is born cancelled:
   * after the shutdown there is no sweep or routes to serve it, and it would wait forever.
   */
  closeAll(): void {
    this.closed = true;
    for (const id of [...this.pending.keys(), ...this.active.keys()]) this.cancel(id, CLOSING);
  }

  private add(id: string, e: Entry) {
    if (this.closed) this.reject(e, new TransferError("cancelled", `Transfer cancelled: ${CLOSING}`));
    else this.pending.set(id, e);
  }

  private expired(e: Entry): boolean {
    return this.now() - e.createdAt > e.ttl;
  }

  private cancel(id: string, reason: string) {
    const err = new TransferError("cancelled", `Transfer cancelled: ${reason}`);
    const e = this.pending.get(id);
    if (e) {
      this.pending.delete(id);
      this.reject(e, err);
      return;
    }
    const a = this.active.get(id);
    if (!a) return; // already finished
    this.active.delete(id);
    // The promise first: if the route reacts to the signal by calling fail(aborted), it does not overwrite it.
    this.reject(a.entry, err);
    a.controller.abort(err);
    // Without an error: destroy(err) on a stream with no 'error' listener would bring down the process; whoever
    // reads it receives a premature close anyway.
    a.stream?.destroy();
  }

  private release(id: string, a: Active) {
    if (this.active.get(id) === a) this.active.delete(id);
  }

  private reject(e: Entry, err: TransferError) {
    if (e.kind === "outbound") e.done.reject(err);
    else e.incoming.reject(err);
  }
}
