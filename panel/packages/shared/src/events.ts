import { z } from "zod";

/** Levels of an event (Event.level from the agent, or from the panel itself). */
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevelName = (typeof EVENT_LEVELS)[number];

/** Valid kinds (the agent's are in the comment on `message Event` in agent.proto); anything else → "other". */
export const EVENT_KIND_RE = /^[a-z_]{1,32}$/;
export const EVENT_MESSAGE_MAX = 1000;

export const EVENT_KIND_LABEL: Readonly<Record<string, string>> = {
  crash: "Exit with error",
  oom: "Out of memory",
  crash_loop: "Crash loop",
  crash_loop_failed: "Crash loop not stopped",
  drift: "Container recreated",
  save_on_pending: "Autosave disabled",
  save_on_resumed: "Autosave re-enabled",
  token_rotated: "Node token rotated",
};

export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABEL[kind] ?? "Other";
}

export const EVENT_LEVEL_LABEL: Readonly<Record<EventLevelName, string>> = { info: "Information", warn: "Warning", error: "Error" };

export interface EventDto {
  id: string;
  nodeId: string | null;
  serverId: string | null;
  /** Server name when it happened (the server may have been deleted). */
  serverName: string | null;
  level: EventLevelName;
  kind: string;
  message: string;
  /** When the panel stored it (list order). */
  createdAt: string;
  /** Agent time, if reasonable. */
  agentAt: string | null;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** GET /api/events: `minLevel` includes the higher levels; `before` paginates by `createdAt`. */
export const eventsQuerySchema = z.object({
  serverId: z.string().min(1).max(64).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  minLevel: z.enum(EVENT_LEVELS).optional(),
  before: z.string().regex(ISO_UTC, "Invalid date (ISO 8601 in UTC)").optional(),
  /** Cursor tiebreaker: with `before`, also the events of that instant with a lower id. */
  beforeId: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
