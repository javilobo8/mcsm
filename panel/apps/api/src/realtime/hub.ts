import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Envelope } from "@mcsm/proto";

type Msg = Record<string, unknown> & { type: string };
type Cancel = () => void;

const LOG_TAIL = 200;
const MAX_SUBSCRIPTIONS = 100;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export interface HubOptions {
  maxSubscriptions?: number;
  maxBufferedBytes?: number;
  /** Schedules `fn` after `ms` milliseconds and returns the function that cancels it (injectable in tests). */
  schedule?: (fn: () => void, ms: number) => Cancel;
}

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

const TOPIC = /^(servers|nodes|jobs|events|server:[^:\s]{1,64}:logs)$/;
const LOG_TOPIC = /^server:([^:]+):logs$/;
const clientMessage = z.object({ type: z.enum(["subscribe", "unsubscribe"]), topic: z.string().max(100).regex(TOPIC) });

export class BrowserHub {
  private clients = new Map<WebSocket, Set<string>>();
  private topics = new Map<string, Set<WebSocket>>();
  private dropped = new Map<WebSocket, Map<string, number>>();
  private sessions = new Map<WebSocket, string | null>();
  private logs: LogRelay;
  private maxSubscriptions: number;
  private maxBuffered: number;
  private offs: (() => void)[] = [];

  constructor(private app: FastifyInstance, opts: HubOptions = {}) {
    this.maxSubscriptions = opts.maxSubscriptions ?? MAX_SUBSCRIPTIONS;
    this.maxBuffered = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    this.logs = new LogRelay(app, this, opts.schedule ?? defaultSchedule);
    const onObserved = (serverId: string, observed: unknown) =>
      this.publish("servers", { type: "observed", serverId, observed, observedAt: new Date().toISOString() });
    const onNode = (node: unknown) => this.publish("nodes", { type: "node", node });
    app.events.on("observed", onObserved);
    app.events.on("node", onNode);
    this.offs.push(() => app.events.off("observed", onObserved), () => app.events.off("node", onNode));
    // plan-2: a node's host sample every 10 s, to whoever follows the "nodes" topic.
    const onNodeMetrics = (nodeId: string, sample: unknown) => this.publish("nodes", { type: "node_metrics", nodeId, sample });
    app.events.on("node_metrics", onNodeMetrics);
    this.offs.push(() => app.events.off("node_metrics", onNodeMetrics));
    // plan-4: jobs and backups on the "jobs" topic
    const onJob = (job: unknown, logChunk: unknown) =>
      this.publish("jobs", { type: "job", job, logChunk: typeof logChunk === "string" ? logChunk : "" });
    const onBackups = (serverId: unknown) => this.publish("jobs", { type: "backups", serverId });
    app.events.on("job", onJob);
    app.events.on("backups", onBackups);
    this.offs.push(() => app.events.off("job", onJob), () => app.events.off("backups", onBackups));
    // plan-8: a node's mc-router state, on the "nodes" topic.
    const onRouter = (nodeId: unknown, router: unknown) => this.publish("nodes", { type: "router", nodeId, router });
    app.events.on("router", onRouter);
    this.offs.push(() => app.events.off("router", onRouter));
    // plan-9: agent and panel events, on the "events" topic.
    const onServerEvent = (event: unknown) => this.publish("events", { type: "event", event });
    app.events.on("server_event", onServerEvent);
    this.offs.push(() => app.events.off("server_event", onServerEvent));
    // plan-9: a revoked session (logout) or all of them (password change) lose their sockets.
    const onSessionsRevoked = (sessionId?: string) => this.closeSessions(sessionId);
    app.events.on("sessions_revoked", onSessionsRevoked);
    this.offs.push(() => app.events.off("sessions_revoked", onSessionsRevoked));
  }

  dispose() {
    for (const off of this.offs) off();
    this.logs.dispose();
  }

  /** Closes with 4401 the sockets of that session (or of all, with no argument). */
  private closeSessions(sessionId?: string) {
    for (const [ws, sid] of this.sessions) {
      if (sessionId === undefined || sid === sessionId) ws.close(4401, "session closed");
    }
  }

  add(socket: WebSocket, sessionId: string | null = null) {
    this.clients.set(socket, new Set());
    this.sessions.set(socket, sessionId);
    socket.on("message", (raw) => {
      try {
        this.onMessage(socket, raw.toString());
      } catch (e) {
        this.app.log.warn({ err: e }, "failure processing browser message");
        this.send(socket, { type: "error", message: "Internal error" });
      }
    });
    socket.on("close", () => {
      for (const t of [...(this.clients.get(socket) ?? [])]) this.unsubscribe(socket, t);
      this.clients.delete(socket);
      this.sessions.delete(socket);
      this.dropped.delete(socket);
    });
  }

  private onMessage(socket: WebSocket, raw: string) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return this.send(socket, { type: "error", message: "Invalid JSON" }); }
    const msg = clientMessage.safeParse(json);
    if (!msg.success) return this.send(socket, { type: "error", message: "Invalid message" });
    if (msg.data.type === "subscribe") this.subscribe(socket, msg.data.topic);
    else this.unsubscribe(socket, msg.data.topic);
  }

  private subscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine || mine.has(topic)) return;
    const m = topic.match(LOG_TOPIC);
    if (m && !this.app.servers.get(m[1]!)) return this.send(socket, { type: "error", message: "Unknown server" });
    if (mine.size >= this.maxSubscriptions) return this.send(socket, { type: "error", message: "Too many subscriptions" });
    mine.add(topic);
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic)!.add(socket);
    if (m) this.logs.retain(m[1]!, socket);
  }

  private unsubscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine?.delete(topic)) return;
    const set = this.topics.get(topic);
    set?.delete(socket);
    if (set && set.size === 0) this.topics.delete(topic);
    const m = topic.match(LOG_TOPIC);
    if (m) {
      this.dropped.get(socket)?.delete(m[1]!);
      this.logs.release(m[1]!);
    }
  }

  /** Status messages: never dropped. */
  publish(topic: string, msg: Msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.topics.get(topic) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  /** Log lines: dropped (and counted) for a socket with more than `maxBuffered` pending. */
  publishLog(serverId: string, msg: Msg) {
    for (const ws of this.topics.get(`server:${serverId}:logs`) ?? []) this.sendLog(ws, serverId, msg);
  }

  /** Sends the reset and the already accumulated lines to a single socket. */
  sendReplay(ws: WebSocket, serverId: string, lines: Msg[]) {
    this.dropped.get(ws)?.delete(serverId);
    this.send(ws, { type: "log_reset", serverId });
    for (const l of lines) this.sendLog(ws, serverId, l);
  }

  /** Reset to all of the server's subscribers (also clears their drop counters). */
  resetLogs(serverId: string) {
    for (const ws of this.topics.get(`server:${serverId}:logs`) ?? []) {
      this.dropped.get(ws)?.delete(serverId);
      this.send(ws, { type: "log_reset", serverId });
    }
  }

  droppedFor(ws: unknown, serverId: string): number {
    return this.dropped.get(ws as WebSocket)?.get(serverId) ?? 0;
  }

  private sendLog(ws: WebSocket, serverId: string, msg: Msg) {
    if (ws.readyState !== ws.OPEN) return;
    let perSocket = this.dropped.get(ws);
    if (ws.bufferedAmount > this.maxBuffered) {
      if (!perSocket) this.dropped.set(ws, (perSocket = new Map()));
      perSocket.set(serverId, (perSocket.get(serverId) ?? 0) + 1);
      return;
    }
    const count = perSocket?.get(serverId);
    if (count) {
      perSocket!.delete(serverId);
      ws.send(JSON.stringify({ type: "log_dropped", serverId, count }));
    }
    ws.send(JSON.stringify(msg));
  }

  private send(ws: WebSocket, msg: Msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

interface RelayEntry {
  count: number;
  close?: () => void;
  opening: boolean;
  needsReset: boolean;
  buffer: Msg[];
  attempt: number;
  cancelRetry?: Cancel;
}

/** Keeps a single log stream per server towards the agent while there are subscribed browsers. */
class LogRelay {
  private active = new Map<string, RelayEntry>();
  private onMessage: (nodeId: string, env: Envelope) => void;

  constructor(private app: FastifyInstance, private hub: BrowserHub, private schedule: (fn: () => void, ms: number) => Cancel) {
    // If the node comes back, the subscribers still there recover the console. It waits for the Hello
    // (not for "attached"): until then the agent is not ready for requests.
    this.onMessage = (nodeId, env) => {
      if (env.body.case !== "hello") return;
      for (const [serverId, entry] of this.active) {
        if (entry.close || entry.opening || entry.count <= 0) continue;
        if (this.app.servers.get(serverId)?.node_id !== nodeId) continue;
        entry.cancelRetry?.();
        entry.cancelRetry = undefined;
        entry.attempt = 0;
        void this.open(serverId, entry);
      }
    };
    app.agents.on("message", this.onMessage);
  }

  dispose() {
    this.app.agents.off("message", this.onMessage);
    for (const e of this.active.values()) e.cancelRetry?.();
  }

  retain(serverId: string, socket: WebSocket) {
    const existing = this.active.get(serverId);
    const entry = existing ?? { count: 0, opening: false, needsReset: true, buffer: [], attempt: 0 };
    entry.count++;
    this.active.set(serverId, entry);
    if (!existing) void this.open(serverId, entry);
    else if (!entry.needsReset) this.hub.sendReplay(socket, serverId, entry.buffer);
  }

  release(serverId: string) {
    const entry = this.active.get(serverId);
    if (!entry) return;
    entry.count--;
    if (entry.count <= 0) {
      this.active.delete(serverId);
      entry.cancelRetry?.();
      entry.close?.();
    }
  }

  private retry(serverId: string, entry: RelayEntry) {
    if (entry.cancelRetry || entry.count <= 0) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** entry.attempt, BACKOFF_MAX_MS);
    entry.attempt++;
    entry.cancelRetry = this.schedule(() => {
      entry.cancelRetry = undefined;
      if (this.active.get(serverId) !== entry || entry.close || entry.opening || entry.count <= 0) return;
      const row = this.app.servers.get(serverId);
      if (!row || !this.app.agents.get(row.node_id)) return; // node down: its next Hello will reopen it
      void this.open(serverId, entry);
    }, delay);
  }

  private async open(serverId: string, entry: RelayEntry) {
    const row = this.app.servers.get(serverId);
    const conn = row && this.app.agents.get(row.node_id);
    if (!conn) {
      this.hub.publish(`server:${serverId}:logs`, { type: "stream_closed", serverId, reason: "node offline" });
      return;
    }
    if (entry.needsReset) {
      entry.needsReset = false;
      entry.buffer = [];
      this.hub.resetLogs(serverId);
    }
    entry.opening = true;
    let closed = false;
    try {
      const stream = await conn.openStream(
        { case: "subscribeLogs", value: { serverId, tail: LOG_TAIL } },
        (env: Envelope) => {
          if (env.body.case === "streamDropped") { // plan-9: the agent dropped lines from this stream (spec §5.2)
            this.hub.publish(`server:${serverId}:logs`, { type: "log_dropped", serverId, count: Number(env.body.value.count) });
            return;
          }
          if (env.body.case !== "logLine") return;
          entry.attempt = 0; // the stream works: the backoff starts over
          const msg = { type: "log", serverId, ts: Number(env.body.value.tsUnixMs), line: env.body.value.line };
          entry.buffer.push(msg);
          if (entry.buffer.length > LOG_TAIL) entry.buffer.shift();
          this.hub.publishLog(serverId, msg);
        },
        (reason) => {
          closed = true;
          this.hub.publish(`server:${serverId}:logs`, { type: "stream_closed", serverId, reason });
          if (this.active.get(serverId) !== entry) return;
          entry.close = undefined;
          entry.needsReset = true;
          this.retry(serverId, entry);
        },
      );
      if (!closed) entry.close = stream.close;
      if (entry.count <= 0) stream.close(); // everyone left while we were opening
    } catch (e) {
      this.hub.publish(`server:${serverId}:logs`, { type: "stream_closed", serverId, reason: e instanceof Error ? e.message : "error" });
      if (this.active.get(serverId) === entry) {
        entry.needsReset = true;
        this.retry(serverId, entry);
      }
    } finally {
      entry.opening = false;
    }
  }
}
