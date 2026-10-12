import type { ServerMessage } from "./api";

export type LineKind = "log" | "cmd" | "out" | "sys";
export interface ConsoleLine { id: number; ts: number; text: string; kind: LineKind }
export interface ConsoleState { lines: ConsoleLine[]; nextId: number }

export const MAX_LINES = 2000;
export const HISTORY_MAX = 50;

export const initialConsole = (): ConsoleState => ({ lines: [], nextId: 1 });

export function pushLine(s: ConsoleState, line: Omit<ConsoleLine, "id">, max = MAX_LINES): ConsoleState {
  const lines = [...s.lines, { ...line, id: s.nextId }];
  return { lines: lines.length > max ? lines.slice(lines.length - max) : lines, nextId: s.nextId + 1 };
}

/** Aplica un mensaje del topic `server:<id>:logs` según el protocolo del panel. */
export function applyMessage(s: ConsoleState, msg: ServerMessage, now: number, max = MAX_LINES): ConsoleState {
  switch (msg.type) {
    case "log": return pushLine(s, { ts: msg.ts || now, text: msg.line, kind: "log" }, max);
    case "log_reset": return { lines: [], nextId: s.nextId };
    case "log_dropped":
      return pushLine(s, { ts: now, text: `— ${msg.count} ${msg.count === 1 ? "línea descartada" : "líneas descartadas"} —`, kind: "sys" }, max);
    case "stream_closed": return pushLine(s, { ts: now, text: "— conexión con el nodo perdida —", kind: "sys" }, max);
    default: return s;
  }
}

export function filterLines(lines: ConsoleLine[], query: string): ConsoleLine[] {
  const q = query.trim().toLowerCase();
  return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
}

/** Añade al historial (más reciente primero), sin duplicados y acotado. */
export function addHistory(h: string[], cmd: string): string[] {
  return [cmd, ...h.filter((x) => x !== cmd)].slice(0, HISTORY_MAX);
}

/** Navega el historial con ↑/↓. idx -1 = línea en edición. */
export function navigateHistory(h: string[], idx: number, dir: "up" | "down"): { idx: number; value: string | null } {
  if (dir === "up") {
    if (!h.length) return { idx, value: null };
    const i = Math.min(idx + 1, h.length - 1);
    return { idx: i, value: h[i]! };
  }
  const i = Math.max(idx - 1, -1);
  return { idx: i, value: i === -1 ? "" : h[i]! };
}

/** ¿El scroll está pegado al final (con margen)? */
export const isAtBottom = (scrollHeight: number, scrollTop: number, clientHeight: number, margin = 40): boolean =>
  scrollHeight - scrollTop - clientHeight < margin;
