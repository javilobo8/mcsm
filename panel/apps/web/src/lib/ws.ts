import type { ServerMessage } from "./api";

type Handler = (msg: ServerMessage) => void;

/** Cierre por falta de sesión (política/no autorizado) */
const AUTH_CLOSE_CODES = new Set([1008, 4401]);

// Topics del panel: "servers", "nodes", "jobs" y "server:<id>:logs".
export function topicOf(msg: ServerMessage): string | null {
  switch (msg.type) {
    case "job":
    case "backups": return "jobs"; // plan-4
    case "node":
    case "node_metrics":
    case "router": return "nodes"; // plan-8: faltaba; el estado del router no llegaba en vivo
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
  /** Comprueba si la sesión sigue viva (el navegador no expone el 401 del upgrade). */
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
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: RealtimeDeps) {}

  private send(payload: object) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(payload));
  }

  private ensure() {
    if (this.ws || this.connecting || this.authLost || this.handlers.size === 0) return;
    this.connecting = true;
    const ws = this.deps.createSocket();
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
      this.ws = null; this.connecting = false;
      if (AUTH_CLOSE_CODES.has(ev.code ?? 0)) return this.loseAuth();
      if (this.handlers.size === 0) return;
      if (!opened) {
        // El upgrade pudo fallar por 401: lo confirmamos antes de reintentar.
        void this.deps.checkAuthenticated().then(
          (ok) => (ok ? this.scheduleRetry() : this.loseAuth()),
          () => this.scheduleRetry(),
        );
        return;
      }
      this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private safe(fn: () => void) {
    try { fn(); } catch (err) { console.error("Error en un manejador de tiempo real", err); }
  }

  private scheduleRetry() {
    if (this.timer || this.authLost || this.handlers.size === 0) return;
    const delay = this.retry * (0.5 + this.deps.random() * 0.5);
    this.retry = Math.min(this.retry * 2, 15000);
    this.timer = setTimeout(() => { this.timer = null; this.ensure(); }, delay);
  }

  private loseAuth() {
    this.authLost = true;
    for (const cb of [...this.authLostCbs]) this.safe(cb);
  }

  /** Reanuda las conexiones tras volver a iniciar sesión. */
  resume() {
    this.authLost = false;
    this.retry = 1000;
    this.ensure();
  }

  /**
   * Se invoca en cada RE-conexión (no en la primera). Durante la desconexión se pierden
   * eventos `observed`/`node`: los consumidores (listas de servidores/nodos) deben
   * invalidar sus queries aquí.
   */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => { this.reconnectCbs.delete(cb); };
  }

  /** Se invoca cuando el panel rechaza la sesión del WebSocket; no se reintenta. */
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
