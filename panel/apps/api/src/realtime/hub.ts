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
  /** Programa `fn` tras `ms` milisegundos y devuelve la función que lo cancela (inyectable en tests). */
  schedule?: (fn: () => void, ms: number) => Cancel;
}

const defaultSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

const TOPIC = /^(servers|nodes|jobs|server:[^:\s]{1,64}:logs)$/;
const LOG_TOPIC = /^server:([^:]+):logs$/;
const clientMessage = z.object({ type: z.enum(["subscribe", "unsubscribe"]), topic: z.string().max(100).regex(TOPIC) });

export class BrowserHub {
  private clients = new Map<WebSocket, Set<string>>();
  private topics = new Map<string, Set<WebSocket>>();
  private dropped = new Map<WebSocket, Map<string, number>>();
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
    // plan-2: muestra del host de un nodo cada 10 s, a quien siga el topic "nodes".
    const onNodeMetrics = (nodeId: string, sample: unknown) => this.publish("nodes", { type: "node_metrics", nodeId, sample });
    app.events.on("node_metrics", onNodeMetrics);
    this.offs.push(() => app.events.off("node_metrics", onNodeMetrics));
    // plan-4: jobs y copias en el topic "jobs"
    const onJob = (job: unknown, logChunk: unknown) =>
      this.publish("jobs", { type: "job", job, logChunk: typeof logChunk === "string" ? logChunk : "" });
    const onBackups = (serverId: unknown) => this.publish("jobs", { type: "backups", serverId });
    app.events.on("job", onJob);
    app.events.on("backups", onBackups);
    this.offs.push(() => app.events.off("job", onJob), () => app.events.off("backups", onBackups));
    // plan-8: estado del mc-router de un nodo, en el topic "nodes".
    const onRouter = (nodeId: unknown, router: unknown) => this.publish("nodes", { type: "router", nodeId, router });
    app.events.on("router", onRouter);
    this.offs.push(() => app.events.off("router", onRouter));
  }

  dispose() {
    for (const off of this.offs) off();
    this.logs.dispose();
  }

  add(socket: WebSocket) {
    this.clients.set(socket, new Set());
    socket.on("message", (raw) => {
      try {
        this.onMessage(socket, raw.toString());
      } catch (e) {
        this.app.log.warn({ err: e }, "fallo procesando mensaje del navegador");
        this.send(socket, { type: "error", message: "Error interno" });
      }
    });
    socket.on("close", () => {
      for (const t of [...(this.clients.get(socket) ?? [])]) this.unsubscribe(socket, t);
      this.clients.delete(socket);
      this.dropped.delete(socket);
    });
  }

  private onMessage(socket: WebSocket, raw: string) {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return this.send(socket, { type: "error", message: "JSON inválido" }); }
    const msg = clientMessage.safeParse(json);
    if (!msg.success) return this.send(socket, { type: "error", message: "Mensaje inválido" });
    if (msg.data.type === "subscribe") this.subscribe(socket, msg.data.topic);
    else this.unsubscribe(socket, msg.data.topic);
  }

  private subscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine || mine.has(topic)) return;
    const m = topic.match(LOG_TOPIC);
    if (m && !this.app.servers.get(m[1]!)) return this.send(socket, { type: "error", message: "Servidor desconocido" });
    if (mine.size >= this.maxSubscriptions) return this.send(socket, { type: "error", message: "Demasiadas suscripciones" });
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

  /** Mensajes de estado: nunca se descartan. */
  publish(topic: string, msg: Msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.topics.get(topic) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  /** Líneas de log: se descartan (y se cuentan) para un socket con más de `maxBuffered` pendiente. */
  publishLog(serverId: string, msg: Msg) {
    for (const ws of this.topics.get(`server:${serverId}:logs`) ?? []) this.sendLog(ws, serverId, msg);
  }

  /** Envía a un solo socket el reset y las líneas ya acumuladas. */
  sendReplay(ws: WebSocket, serverId: string, lines: Msg[]) {
    this.dropped.get(ws)?.delete(serverId);
    this.send(ws, { type: "log_reset", serverId });
    for (const l of lines) this.sendLog(ws, serverId, l);
  }

  /** Reset a todos los suscriptores del servidor (también limpia sus contadores de descartes). */
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

/** Mantiene un único stream de logs por servidor hacia el agente mientras haya navegadores suscritos. */
class LogRelay {
  private active = new Map<string, RelayEntry>();
  private onMessage: (nodeId: string, env: Envelope) => void;

  constructor(private app: FastifyInstance, private hub: BrowserHub, private schedule: (fn: () => void, ms: number) => Cancel) {
    // Si el nodo vuelve, los suscriptores que siguen ahí recuperan la consola. Se espera al Hello
    // (no a "attached"): hasta entonces el agente aún no está listo para peticiones.
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
      if (!row || !this.app.agents.get(row.node_id)) return; // nodo caído: lo reabrirá su próximo Hello
      void this.open(serverId, entry);
    }, delay);
  }

  private async open(serverId: string, entry: RelayEntry) {
    const row = this.app.servers.get(serverId);
    const conn = row && this.app.agents.get(row.node_id);
    if (!conn) {
      this.hub.publish(`server:${serverId}:logs`, { type: "stream_closed", serverId, reason: "nodo desconectado" });
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
          if (env.body.case !== "logLine") return;
          entry.attempt = 0; // el stream funciona: el backoff vuelve a empezar
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
      if (entry.count <= 0) stream.close(); // todos se fueron mientras abríamos
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
