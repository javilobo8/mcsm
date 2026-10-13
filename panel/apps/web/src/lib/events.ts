import type { QueryClient } from "@tanstack/react-query";
import type { EventDto, EventLevelName } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";

export type EventsFilter = { serverId?: string; minLevel?: EventLevelName };

export const eventsKey = (f: EventsFilter) => ["events", f.serverId ?? "", f.minLevel ?? ""] as const;

/** Cuántos eventos recientes muestra la lista. */
export const EVENTS_LIMIT = 100;

/** GET /api/events con los filtros codificados (los más recientes, hasta EVENTS_LIMIT). */
export function eventsUrl(f: EventsFilter): string {
  const p = new URLSearchParams({ limit: String(EVENTS_LIMIT) });
  if (f.serverId) p.set("serverId", f.serverId);
  if (f.minLevel) p.set("minLevel", f.minLevel);
  return `/api/events?${p}`;
}

const TONES: Record<EventLevelName, string> = {
  info: "border-sky-800 text-sky-300",
  warn: "border-amber-700 text-amber-300",
  error: "border-red-800 text-red-300",
};
export const levelTone = (level: EventLevelName): string => TONES[level];

/** De qué trata el evento: su servidor (con el nombre de entonces), su nodo o el panel. */
export function eventSubject(e: EventDto, nodeName?: string): string {
  if (e.serverId) return e.serverName ?? e.serverId;
  if (e.nodeId) return `Nodo «${nodeName ?? e.nodeId}»`;
  return "Panel";
}

type EventMsg = Extract<ServerMessage, { type: "event" }>;

/** Un evento nuevo recarga las listas; un bucle de crash, además, el servidor (el panel lo dejó en «parado»). */
export function applyServerEvent(qc: QueryClient, msg: EventMsg): void {
  void qc.invalidateQueries({ queryKey: ["events"] });
  if (msg.event.kind === "crash_loop" && msg.event.serverId) {
    void qc.invalidateQueries({ queryKey: ["server", msg.event.serverId] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
  }
}

/** Conecta el topic `events` con la caché. Devuelve la función de limpieza. */
export function bindEvents(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("events", (m) => { if (m.type === "event") applyServerEvent(qc, m); }),
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: ["events"] }); }),
  ];
  return () => offs.forEach((off) => off());
}

export const EVENT_FILTERS: readonly { label: string; minLevel?: EventLevelName }[] = [
  { label: "Todos" },
  { label: "Avisos y errores", minLevel: "warn" },
  { label: "Errores", minLevel: "error" },
];
