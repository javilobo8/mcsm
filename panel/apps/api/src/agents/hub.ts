import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { EnvelopeSchema, type Envelope } from "@mcsm/proto";
import { AgentErrorCode } from "./error-codes.js";

/** Envelope body in initializer form: accepts plain objects without $typeName. */
export type Body = NonNullable<MessageInitShape<typeof EnvelopeSchema>["body"]>;

/** Failure of a request to the agent. `code`: catalog in ./error-codes.ts (string: the agent may send new codes). */
export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AgentError"; }
}

export interface HubLogger { warn(obj: object, msg: string): void }

export interface HubOptions {
  /** Logger for callback failures and unreadable messages. */
  log?: HubLogger;
  /** Injectable clock (ms). */
  now?: () => number;
  /** With no activity for this long the agent is considered down (spec §5.1). */
  idleTimeoutMs?: number;
  /** How often activity is checked. */
  checkIntervalMs?: number;
  /** First panel envelope id (tests). Random by default: see `AgentHub.allocateId`. */
  firstId?: bigint;
}

type ResolvedOptions = Required<Omit<HubOptions, "log" | "firstId">> & { log: HubLogger };

/**
 * Bodies that are a response to a panel request: only these resolve `pending`.
 * Protocol convention: every response carrying data is named `*Result` (CommandResult,
 * FilesListResult…), so each area adds responses without touching this function.
 */
export const isResponseCase = (c: string | undefined): boolean =>
  c === "ack" || c === "error" || (c?.endsWith("Result") ?? false);

interface Pending { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Stream { onFrame: (e: Envelope) => void; onClose: (reason: string) => void }

export class AgentConn {
  private pending = new Map<bigint, Pending>();
  private streams = new Map<bigint, Stream>();
  private lastActivity: number;
  private heartbeat: NodeJS.Timeout;
  private disposed = false;
  private isReady = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  /**
   * Resolves with the SyncSpecs Ack (`markReady`) and rejects with `disconnected` if the
   * connection drops first. `request`/`openStream` wait for it: no request goes out to the agent
   * before it has the panel's snapshot (except SyncSpecs itself).
   */
  readonly ready: Promise<void>;

  constructor(
    readonly nodeId: string,
    private socket: WebSocket,
    private hub: AgentHub,
    private opts: ResolvedOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {}); // nobody is obliged to wait for it: no unhandled rejection
    this.lastActivity = opts.now();
    // Any message or ping from the agent (it sends one every 15 s) counts as activity.
    socket.on("message", (data: Buffer) => {
      this.lastActivity = this.opts.now();
      this.handle(data);
    });
    socket.on("ping", () => { this.lastActivity = this.opts.now(); });
    socket.on("close", () => this.dispose("connection closed"));
    socket.on("error", () => this.dispose("socket error"));
    this.heartbeat = setInterval(() => {
      if (this.opts.now() - this.lastActivity > this.opts.idleTimeoutMs) {
        this.socket.terminate();
        this.dispose("no activity from the agent");
      }
    }, opts.checkIntervalMs);
    this.heartbeat.unref();
  }

  send(body: Body, opts: { id?: bigint; streamId?: bigint } = {}): bigint {
    const id = opts.id ?? this.hub.allocateId();
    const env = create(EnvelopeSchema, { id, streamId: opts.streamId ?? 0n, body });
    this.socket.send(toBinary(EnvelopeSchema, env));
    return id;
  }

  /** Marks the session as synchronized (SyncSpecs Ack): releases the held requests. */
  markReady() {
    if (this.disposed || this.isReady) return;
    this.isReady = true;
    this.resolveReady();
  }

  /**
   * Sends a request and waits for its response (Ack, Error or CommandResult with the same id).
   * Until `ready` the request is held (except `syncSpecs`); `timeoutMs` counts from the
   * call: if it expires while held it fails with `syncing`, if it expires once sent with `timeout`.
   */
  request(body: Body, timeoutMs = 30_000): Promise<Envelope> {
    return this.requestTracked(body, timeoutMs).response;
  }

  /**
   * Like `request`, but also returns the envelope id, already fixed on return: useful to
   * correlate an unsolicited message that cites it (BackupInventory.request_id), which
   * may arrive before the response.
   */
  requestTracked(body: Body, timeoutMs = 30_000): { id: bigint; response: Promise<Envelope> } {
    const id = this.hub.allocateId();
    return { id, response: this.requestWithId(id, body, timeoutMs) };
  }

  private requestWithId(id: bigint, body: Body, timeoutMs: number): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      if (this.disposed || this.socket.readyState !== this.socket.OPEN) {
        reject(new AgentError(AgentErrorCode.Disconnected, "The node is not connected"));
        return;
      }
      let sent = false;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(sent
          ? new AgentError(AgentErrorCode.Timeout, "The agent did not respond in time")
          : new AgentError(AgentErrorCode.Syncing, "The node is syncing; try again in a few seconds"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const go = () => {
        if (!this.pending.has(id)) return; // the deadline expired or the connection dropped while waiting
        try {
          this.send(body, { id });
          sent = true;
        } catch {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AgentError(AgentErrorCode.Disconnected, "Could not send to the node"));
        }
      };
      if (this.isReady || body.case === "syncSpecs") go();
      else this.ready.then(go, () => { /* dispose already rejected the pending one */ });
    });
  }

  async openStream(body: Body, onFrame: (e: Envelope) => void, onClose: (reason: string) => void): Promise<{ streamId: bigint; close(): void }> {
    // The protocol sets stream_id = request id: it is registered BEFORE sending, because
    // the Ack and the first lines may arrive in the same chunk and be emitted without yielding the turn.
    const streamId = this.hub.allocateId();
    this.streams.set(streamId, { onFrame, onClose });
    try {
      const ack = await this.requestWithId(streamId, body, 30_000);
      if (ack.streamId !== streamId) throw new AgentError(AgentErrorCode.Protocol, "The agent did not return a stream_id");
    } catch (e) {
      this.streams.delete(streamId);
      throw e;
    }
    return {
      streamId,
      close: () => {
        if (!this.streams.delete(streamId)) return;
        if (this.socket.readyState === this.socket.OPEN) {
          this.send({ case: "streamClose", value: { reason: "closed by the panel" } }, { streamId });
        }
      },
    };
  }

  private handle(data: Buffer) {
    let env: Envelope;
    try {
      env = fromBinary(EnvelopeSchema, new Uint8Array(data));
    } catch {
      this.opts.log.warn({ nodeId: this.nodeId }, "unreadable protobuf message from the agent");
      return;
    }
    try {
      this.dispatch(env);
    } catch (e) {
      this.opts.log.warn({ nodeId: this.nodeId, err: e, type: env.body.case }, "failure processing agent message");
    }
  }

  private dispatch(env: Envelope) {
    // Only responses (with id != 0) resolve requests; an unsolicited message
    // with the same id (hello, serverObserved, logLine...) never consumes them.
    if (env.id !== 0n && isResponseCase(env.body.case)) {
      const p = this.pending.get(env.id);
      if (p) {
        this.pending.delete(env.id);
        clearTimeout(p.timer);
        if (env.body.case === "error") p.reject(new AgentError(env.body.value.code, env.body.value.message));
        else p.resolve(env);
        return;
      }
    }
    if (env.streamId !== 0n) {
      const s = this.streams.get(env.streamId);
      if (!s) return;
      if (env.body.case === "streamClose") {
        this.streams.delete(env.streamId);
        const reason = env.body.value.reason;
        this.safe(() => s.onClose(reason), "stream onClose");
      } else {
        this.safe(() => s.onFrame(env), "stream onFrame");
      }
      return;
    }
    this.hub.emit("message", this.nodeId, env);
  }

  private safe(fn: () => void, what: string) {
    try {
      fn();
    } catch (e) {
      this.opts.log.warn({ nodeId: this.nodeId, err: e }, `failure in ${what}`);
    }
  }

  private dispose(reason: string) {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat);
    this.rejectReady(new AgentError(AgentErrorCode.Disconnected, "The node disconnected"));
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentError(AgentErrorCode.Disconnected, "The node disconnected"));
      this.pending.delete(id);
    }
    for (const [id, s] of this.streams) {
      this.streams.delete(id);
      this.safe(() => s.onClose(reason), "stream onClose");
    }
    this.hub.detach(this.nodeId, this);
  }

  terminate() { this.socket.terminate(); }
  /** The socket is open and the connection has not been discarded: a request will really go out. */
  get isOpen(): boolean { return !this.disposed && this.socket.readyState === this.socket.OPEN; }
}

export class AgentHub extends EventEmitter {
  private conns = new Map<string, AgentConn>();
  private opts: ResolvedOptions;
  private nextId: bigint;

  constructor(opts: HubOptions = {}) {
    super();
    const { firstId, ...rest } = opts;
    this.opts = { now: Date.now, idleTimeoutMs: 45_000, checkIntervalMs: 5_000, log: { warn: () => {} }, ...rest };
    // 0 is "unsolicited" and 1 is used by the agent's Hello. Far below 2^53.
    this.nextId = firstId ?? 2n + BigInt(randomInt(0, 2 ** 47));
  }

  /**
   * Id for a panel envelope. A single counter for all sessions of the process, and
   * each process starts at a random point: an id is never repeated across sessions, so
   * whatever the agent queued in a previous session (or for a previous panel) and delivers in the
   * current one never cites a request of this one (see BackupInventory.request_id).
   */
  allocateId(): bigint {
    return this.nextId++;
  }

  attach(nodeId: string, socket: WebSocket): AgentConn {
    this.conns.get(nodeId)?.terminate(); // a single session per node
    const conn = new AgentConn(nodeId, socket, this, this.opts);
    this.conns.set(nodeId, conn);
    this.emit("attached", nodeId);
    return conn;
  }

  detach(nodeId: string, conn?: AgentConn) {
    const current = this.conns.get(nodeId);
    if (conn && current !== conn) return; // it was already replaced by a new session
    this.conns.delete(nodeId);
    this.emit("detached", nodeId);
  }

  /** Nodes with an open session. */
  onlineIds(): string[] { return [...this.conns.keys()]; }

  get(nodeId: string): AgentConn | undefined { return this.conns.get(nodeId); }
  isOnline(nodeId: string): boolean { return this.conns.has(nodeId); }
}
