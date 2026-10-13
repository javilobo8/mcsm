import type { ServerMessage } from "./api";

type Handler = (msg: ServerMessage) => void;

/** Close due to lack of a session (policy/unauthorized) */
const AUTH_CLOSE_CODES = new Set([1008, 4401]);

/**
 * What to do when a mutation that changes the session (password change) ends: the server closes with
 * 4401 the WS of the revoked sessions, including that of whoever changes it, and issues a new cookie to them.
 * Success: reconnect with the new cookie. Failure after seeing a 4401: the session is considered lost.
 */
export function settleSessionChange(sawAuthClose: boolean, ok: boolean): "reconnect" | "lose" | "none" {
  if (ok) return "reconnect";
  return sawAuthClose ? "lose" : "none";
}

// Panel topics: "servers", "nodes", "jobs" and "server:<id>:logs".
export function topicOf(msg: ServerMessage): string | null {
  switch (msg.type) {
    case "job":
    case "backups": return "jobs"; // plan-4
    case "node":
    case "node_metrics":
    case "router": return "nodes"; // plan-8: it was missing; the router state did not arrive live
    case "event": return "events"; // plan-9
    case "observed": return "servers";
    case "log":
    case "log_reset":
    case "log_dropped":
    case "stream_closed": return `server:${msg.serverId}:logs`;
    default: return null;
  }
}

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeDeps {
  createSocket: () => SocketLike;
  /** Checks whether the session is still alive (the browser does not expose the upgrade's 401). */
  checkAuthenticated: () => Promise<boolean>;
  random: () => number;
}

const OPEN = 1;

export class Realtime {
  private ws: SocketLike | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private reconnectCbs = new Set<() => void>();
  private authLostCbs = new Set<() => void>();
  private retry = 1000;
  private connecting = false;
  private everOpened = false;
  private authLost = false;
  private current: SocketLike | null = null;
  /** Session changes in progress (they can overlap) and whether any of the batch ended well. */
  private expecting = 0;
  private batchOk = false;
  /** Goes up with each settle(true): a session check launched earlier no longer counts (old cookie). */
  private generation = 0;
  private sawAuthClose = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: RealtimeDeps) {}

  private send(payload: object) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(payload));
  }

  private ensure() {
    if (this.ws || this.connecting || this.authLost || this.handlers.size === 0) return;
    this.connecting = true;
    const ws = this.deps.createSocket();
    this.current = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.ws = ws; this.connecting = false; this.retry = 1000;
      const reconnected = this.everOpened;
      this.everOpened = true;
      for (const topic of this.handlers.keys()) this.send({ type: "subscribe", topic });
      if (reconnected) for (const cb of [...this.reconnectCbs]) this.safe(cb);
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (typeof msg !== "object" || msg === null || typeof (msg as { type?: unknown }).type !== "string") return;
      const m = msg as ServerMessage;
      const topic = topicOf(m);
      if (!topic) return;
      for (const h of [...(this.handlers.get(topic) ?? [])]) this.safe(() => h(m));
    };
    ws.onclose = (ev) => {
      this.ws = null; this.connecting = false; this.current = null;
      if (AUTH_CLOSE_CODES.has(ev.code ?? 0)) return this.authFailed();
      if (this.handlers.size === 0) return;
      if (!opened) {
        // The upgrade may have failed because of a 401: we confirm before retrying.
        const gen = this.generation;
        void this.deps.checkAuthenticated().then(
          (ok) => { if (gen === this.generation) { if (ok) this.scheduleRetry(); else this.authFailed(); } },
          () => { if (gen === this.generation) this.scheduleRetry(); },
        );
        return;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private safe(fn: () => void) {
    try { fn(); } catch (err) { console.error("Error in a realtime handler", err); }
  }

  private scheduleRetry() {
    if (this.timer || this.authLost || this.handlers.size === 0) return;
    const delay = this.retry * (0.5 + this.deps.random() * 0.5);
    this.retry = Math.min(this.retry * 2, 15000);
    this.timer = setTimeout(() => { this.timer = null; this.ensure(); }, delay);
  }

  /** Session rejected: while it is being changed on purpose (password) it is only noted; `expectSessionChange` decides. */
  private authFailed() {
    if (this.expecting > 0) { this.sawAuthClose = true; return; }
    this.loseAuth();
  }

  /**
   * Signals that the mutation in progress changes the session (password change): a WS 4401 does not count as
   * a lost session. Returns the function to call when it ends with `true` (success) or `false` (failure).
   */
  expectSessionChange(): (ok: boolean) => void {
    if (this.expecting === 0) { this.sawAuthClose = false; this.batchOk = false; }
    this.expecting++;
    let settled = false;
    return (ok) => {
      if (settled) return;
      settled = true;
      this.expecting--;
      if (ok) this.batchOk = true;
      const last = this.expecting === 0;
      const saw = this.sawAuthClose;
      if (last) { this.sawAuthClose = false; }
      // With overlaps, the session is only considered lost when the last one ends and none of the batch succeeded.
      if (last && !this.batchOk && settleSessionChange(saw, false) === "lose") return this.loseAuth();
      if (!ok || this.authLost) return;
      // The new cookie is already set: a new socket is opened and the old one (if still there) is discarded without listening to its close.
      this.generation++;
      const old = this.current;
      if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; old.close(); }
      this.ws = null; this.current = null; this.connecting = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.retry = 1000;
      this.ensure();
    };
  }

  private loseAuth() {
    this.authLost = true;
    for (const cb of [...this.authLostCbs]) this.safe(cb);
  }

  /** Resumes the connections after signing in again. */
  resume() {
    this.authLost = false;
    this.retry = 1000;
    this.ensure();
  }

  /**
   * Called on every RE-connection (not the first). During the disconnection
   * `observed`/`node` events are lost: the consumers (server/node lists) must
   * invalidate their queries here.
   */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => { this.reconnectCbs.delete(cb); };
  }

  /** Called when the panel rejects the WebSocket session; it is not retried. */
  onAuthLost(cb: () => void): () => void {
    this.authLostCbs.add(cb);
    return () => { this.authLostCbs.delete(cb); };
  }

  subscribe(topic: string, handler: Handler): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
      this.send({ type: "subscribe", topic });
    }
    this.handlers.get(topic)!.add(handler);
    this.ensure();
    return () => {
      const set = this.handlers.get(topic);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.handlers.delete(topic);
        this.send({ type: "unsubscribe", topic });
      }
    };
  }
}

export const realtime = new Realtime({
  createSocket: () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${proto}://${location.host}/ws`) as unknown as SocketLike;
  },
  checkAuthenticated: async () => {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    return ((await res.json()) as { authenticated?: boolean }).authenticated === true;
  },
  random: Math.random,
});
