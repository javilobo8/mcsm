import type { ServerMessage } from "./api";

type Handler = (msg: ServerMessage) => void;

// Topics del panel: "servers", "nodes" y "server:<id>:logs".
function topicOf(msg: ServerMessage): string | null {
  switch (msg.type) {
    case "node": return "nodes";
    case "observed": return "servers";
    case "log":
    case "stream_closed": return `server:${msg.serverId}:logs`;
    default: return null;
  }
}

class Realtime {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 1000;
  private connecting = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private send(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private ensure() {
    if (this.ws || this.connecting || this.handlers.size === 0) return;
    this.connecting = true;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      this.ws = ws; this.connecting = false; this.retry = 1000;
      for (const topic of this.handlers.keys()) this.send({ type: "subscribe", topic });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data as string) as ServerMessage; } catch { return; }
      const topic = topicOf(msg);
      if (!topic) return;
      for (const h of this.handlers.get(topic) ?? []) h(msg);
    };
    ws.onclose = () => {
      this.ws = null; this.connecting = false;
      if (this.handlers.size > 0 && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.ensure(); }, this.retry);
        this.retry = Math.min(this.retry * 2, 15000);
      }
    };
    ws.onerror = () => ws.close();
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

export const realtime = new Realtime();
