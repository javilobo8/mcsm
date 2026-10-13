import type { ServerMessage } from "./api";

type Handler = (msg: ServerMessage) => void;

/** Cierre por falta de sesión (política/no autorizado) */
const AUTH_CLOSE_CODES = new Set([1008, 4401]);

/**
 * Qué hacer al terminar una mutación que cambia la sesión (cambio de contraseña): el servidor cierra con
 * 4401 los WS de las sesiones revocadas, también el de quien la cambia, y le emite una cookie nueva.
 * Éxito: se reconecta con la cookie nueva. Fallo tras haber visto un 4401: la sesión se da por perdida.
 */
export function settleSessionChange(sawAuthClose: boolean, ok: boolean): "reconnect" | "lose" | "none" {
  if (ok) return "reconnect";
  return sawAuthClose ? "lose" : "none";
}

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
  private current: SocketLike | null = null;
  private expecting = false;
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
        // El upgrade pudo fallar por 401: lo confirmamos antes de reintentar.
        void this.deps.checkAuthenticated().then(
          (ok) => (ok ? this.scheduleRetry() : this.authFailed()),
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

  /** Sesión rechazada: mientras se cambia a propósito (contraseña) solo se anota; lo decide `expectSessionChange`. */
  private authFailed() {
    if (this.expecting) { this.sawAuthClose = true; return; }
    this.loseAuth();
  }

  /**
   * Avisa de que la mutación en curso cambia la sesión (cambio de contraseña): un 4401 del WS no cuenta como
   * sesión perdida. Devuelve la función a llamar al terminar con `true` (éxito) o `false` (fallo).
   */
  expectSessionChange(): (ok: boolean) => void {
    this.expecting = true; this.sawAuthClose = false;
    return (ok) => {
      const action = settleSessionChange(this.sawAuthClose, ok);
      this.expecting = false; this.sawAuthClose = false;
      if (action === "lose") return this.loseAuth();
      if (action !== "reconnect" || this.authLost) return;
      // La cookie nueva ya está puesta: se abre un socket nuevo y el viejo (si sigue) se descarta sin escuchar su cierre.
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
