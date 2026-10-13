import type { ServerMessage } from "./api";

export type LineKind = "log" | "cmd" | "out" | "sys";
export interface ConsoleLine { id: number; ts: number; time: string; text: string; kind: LineKind }
export interface ConsoleState { lines: ConsoleLine[]; nextId: number }

export const MAX_LINES = 2000;
export const HISTORY_MAX = 50;

export const initialConsole = (): ConsoleState => ({ lines: [], nextId: 1 });

/** Strips ANSI sequences (`ESC[...m`) and Minecraft colour codes (`§x`). */
export function stripFormatting(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/§[0-9a-fk-or]/gi, "");
}

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

export function pushLine(s: ConsoleState, line: Omit<ConsoleLine, "id" | "time">, max = MAX_LINES): ConsoleState {
  const lines = [...s.lines, { ...line, time: formatTime(line.ts), id: s.nextId }];
  return { lines: lines.length > max ? lines.slice(lines.length - max) : lines, nextId: s.nextId + 1 };
}

/** Applies a message of the `server:<id>:logs` topic according to the panel's protocol. */
export function applyMessage(s: ConsoleState, msg: ServerMessage, now: number, max = MAX_LINES): ConsoleState {
  switch (msg.type) {
    case "log": return pushLine(s, { ts: msg.ts || now, text: stripFormatting(msg.line), kind: "log" }, max);
    case "log_reset": return { lines: [], nextId: s.nextId };
    case "log_dropped":
      return pushLine(s, { ts: now, text: `— ${msg.count} ${msg.count === 1 ? "line dropped" : "lines dropped"} —`, kind: "sys" }, max);
    case "stream_closed": return pushLine(s, { ts: now, text: "— connection to the node lost —", kind: "sys" }, max);
    default: return s;
  }
}

/** Applies a batch of messages in order with a single final copy of the buffer. */
export function applyBatch(s: ConsoleState, msgs: ServerMessage[], now: number, max = MAX_LINES): ConsoleState {
  let cur = s;
  for (const m of msgs) cur = applyMessage(cur, m, now, max);
  return cur;
}

export function filterLines(lines: ConsoleLine[], query: string): ConsoleLine[] {
  const q = query.trim().toLowerCase();
  return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
}

/** Adds to the history (most recent first), without duplicates and bounded. */
export function addHistory(h: string[], cmd: string): string[] {
  return [cmd, ...h.filter((x) => x !== cmd)].slice(0, HISTORY_MAX);
}

/** Navigates the history with ↑/↓. idx -1 = line being edited. */
export function navigateHistory(h: string[], idx: number, dir: "up" | "down"): { idx: number; value: string | null } {
  if (dir === "up") {
    if (!h.length) return { idx, value: null };
    const i = Math.min(idx + 1, h.length - 1);
    return { idx: i, value: h[i]! };
  }
  const i = Math.max(idx - 1, -1);
  return { idx: i, value: i === -1 ? "" : h[i]! };
}

/** Is the scroll stuck to the end (with a margin)? */
export const isAtBottom = (scrollHeight: number, scrollTop: number, clientHeight: number, margin = 40): boolean =>
  scrollHeight - scrollTop - clientHeight < margin;
