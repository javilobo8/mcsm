import type { QueryClient } from "@tanstack/react-query";
import type { EventDto, EventLevelName } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";

export type EventsFilter = { serverId?: string; minLevel?: EventLevelName };

export const eventsKey = (f: EventsFilter) => ["events", f.serverId ?? "", f.minLevel ?? ""] as const;

/** How many recent events the list shows. */
export const EVENTS_LIMIT = 100;

/** GET /api/events with the filters encoded (the most recent ones, up to EVENTS_LIMIT). */
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

/** What the event is about: its server (with the name it had then), its node or the panel. */
export function eventSubject(e: EventDto, nodeName?: string): string {
  if (e.serverId) return e.serverName ?? e.serverId;
  if (e.nodeId) return `Node “${nodeName ?? e.nodeId}”`;
  return "Panel";
}

type EventMsg = Extract<ServerMessage, { type: "event" }>;

/** A new event reloads the lists; a crash loop also reloads the server (the panel left it “stopped”). */
export function applyServerEvent(qc: QueryClient, msg: EventMsg): void {
  void qc.invalidateQueries({ queryKey: ["events"] });
  if (msg.event.kind === "crash_loop" && msg.event.serverId) {
    void qc.invalidateQueries({ queryKey: ["server", msg.event.serverId] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
  }
}

/** Connects the `events` topic to the cache. Returns the cleanup function. */
export function bindEvents(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("events", (m) => { if (m.type === "event") applyServerEvent(qc, m); }),
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: ["events"] }); }),
  ];
  return () => offs.forEach((off) => off());
}

export const EVENT_FILTERS: readonly { label: string; minLevel?: EventLevelName }[] = [
  { label: "All" },
  { label: "Warnings and errors", minLevel: "warn" },
  { label: "Errors", minLevel: "error" },
];
