import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Envelope } from "@mcsm/proto";

type Msg = Record<string, unknown> & { type: string };

const LOG_TAIL = 200;

export class BrowserHub {
  private clients = new Map<WebSocket, Set<string>>();
  private topics = new Map<string, Set<WebSocket>>();
  private logs: LogRelay;

  constructor(private app: FastifyInstance) {
    this.logs = new LogRelay(app, this);
    app.events.on("observed", (serverId: string, observed: unknown) =>
      this.publish("servers", { type: "observed", serverId, observed, observedAt: new Date().toISOString() }));
    app.events.on("node", (node: unknown) => this.publish("nodes", { type: "node", node }));
  }

  add(socket: WebSocket) {
    this.clients.set(socket, new Set());
    socket.on("message", (raw) => {
      let msg: { type?: string; topic?: string };
      try { msg = JSON.parse(raw.toString()); } catch { return this.send(socket, { type: "error", message: "JSON inválido" }); }
      if (typeof msg.topic !== "string") return this.send(socket, { type: "error", message: "topic requerido" });
      if (msg.type === "subscribe") this.subscribe(socket, msg.topic);
      else if (msg.type === "unsubscribe") this.unsubscribe(socket, msg.topic);
    });
    socket.on("close", () => {
      for (const t of this.clients.get(socket) ?? []) this.unsubscribe(socket, t);
      this.clients.delete(socket);
    });
  }

  private subscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine || mine.has(topic)) return;
    const m = topic.match(/^server:([^:]+):logs$/);
    if (m && !this.app.servers.get(m[1]!)) return this.send(socket, { type: "error", message: "Servidor desconocido" });
    mine.add(topic);
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic)!.add(socket);
    if (m) this.logs.retain(m[1]!);
  }

  private unsubscribe(socket: WebSocket, topic: string) {
    const mine = this.clients.get(socket);
    if (!mine?.delete(topic)) return;
    const set = this.topics.get(topic);
    set?.delete(socket);
    if (set && set.size === 0) this.topics.delete(topic);
    const m = topic.match(/^server:([^:]+):logs$/);
    if (m) this.logs.release(m[1]!);
  }

  publish(topic: string, msg: Msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.topics.get(topic) ?? []) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private send(ws: WebSocket, msg: Msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

type RelayEntry = { count: number; close?: () => void; opening: boolean };

/** Mantiene un único stream de logs por servidor hacia el agente mientras haya navegadores suscritos. */
class LogRelay {
  private active = new Map<string, RelayEntry>();

  constructor(private app: FastifyInstance, private hub: BrowserHub) {
    // Si el nodo vuelve, los suscriptores que siguen ahí recuperan la consola. Se espera al Hello
    // (no a "attached"): hasta entonces el agente aún no está listo para peticiones.
    app.agents.on("message", (nodeId: string, env: Envelope) => {
      if (env.body.case !== "hello") return;
      for (const [serverId, entry] of this.active) {
        if (entry.close || entry.opening || entry.count <= 0) continue;
        if (this.app.servers.get(serverId)?.node_id === nodeId) void this.open(serverId, entry);
      }
    });
  }

  retain(serverId: string) {
    const entry = this.active.get(serverId) ?? { count: 0, opening: false };
    entry.count++;
    this.active.set(serverId, entry);
    if (entry.count === 1) void this.open(serverId, entry);
  }

  release(serverId: string) {
    const entry = this.active.get(serverId);
    if (!entry) return;
    entry.count--;
    if (entry.count <= 0) {
      this.active.delete(serverId);
      entry.close?.();
    }
  }

  private async open(serverId: string, entry: RelayEntry) {
    const row = this.app.servers.get(serverId);
    const conn = row && this.app.agents.get(row.node_id);
    const topic = `server:${serverId}:logs`;
    if (!conn) {
      this.hub.publish(topic, { type: "stream_closed", serverId, reason: "nodo desconectado" });
      return;
    }
    entry.opening = true;
    let closed = false;
    try {
      const stream = await conn.openStream(
        { case: "subscribeLogs", value: { serverId, tail: LOG_TAIL } },
        (env: Envelope) => {
          if (env.body.case === "logLine") {
            this.hub.publish(topic, { type: "log", serverId, ts: Number(env.body.value.tsUnixMs), line: env.body.value.line });
          }
        },
        (reason) => {
          closed = true;
          this.hub.publish(topic, { type: "stream_closed", serverId, reason });
          if (this.active.get(serverId) === entry) entry.close = undefined;
        },
      );
      if (!closed) entry.close = stream.close;
      if (entry.count <= 0) stream.close(); // todos se fueron mientras abríamos
    } catch (e) {
      this.hub.publish(topic, { type: "stream_closed", serverId, reason: e instanceof Error ? e.message : "error" });
    } finally {
      entry.opening = false;
    }
  }
}
