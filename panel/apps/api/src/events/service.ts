import type { FastifyInstance } from "fastify";
import { EventLevel, type Event as AgentEvent } from "@mcsm/proto";
import { EVENT_KIND_RE, EVENT_MESSAGE_MAX, type EventDto, type EventLevelName, type EventsQuery } from "@mcsm/shared";
import { newId } from "../lib/ids.js";
import { agentIso } from "../lib/time.js";
import { EventsRepo, toEventDto, type EventRow } from "./repo.js";

export const EVENT_RETENTION_DAYS = 30;
export const MAX_EVENTS = 10_000;
const PURGE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

const LEVELS: Partial<Record<EventLevel, EventLevelName>> = {
  [EventLevel.INFO]: "info", [EventLevel.WARN]: "warn", [EventLevel.ERROR]: "error",
};

type Cancel = () => void;
export interface EventsOptions {
  /** Clock in ms (tests). */
  now?: () => number;
  /** Repeats `fn` every `ms` and returns the function that cancels it (tests). */
  every?: (fn: () => void, ms: number) => Cancel;
}

export interface RecordInput {
  nodeId: string | null; serverId: string | null; serverName?: string | null;
  level: EventLevelName; kind: string; message: string; agentAt?: string | null;
}

const defaultEvery = (fn: () => void, ms: number): Cancel => {
  const t = setInterval(fn, ms);
  t.unref();
  return () => clearInterval(t);
};

/** Agent (Event, spec §5.3) and panel events: `events` table, `events` WS topic. */
export class EventsService {
  private stopPurge: Cancel | null = null;
  private now: () => number;

  constructor(private app: FastifyInstance, private repo: EventsRepo, private opts: EventsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Stores an event and publishes it (`server_event` → `events` topic). */
  record(i: RecordInput): EventDto {
    const row: EventRow = {
      id: newId(), node_id: i.nodeId, server_id: i.serverId, server_name: i.serverName ?? null, level: i.level,
      kind: EVENT_KIND_RE.test(i.kind) ? i.kind : "other", message: i.message.slice(0, EVENT_MESSAGE_MAX),
      agent_at: i.agentAt ?? null, created_at: new Date(this.now()).toISOString(),
    };
    this.repo.insert(row);
    const dto = toEventDto(row);
    this.app.events.emit("server_event", dto);
    return dto;
  }

  /**
   * Unsolicited Event from an agent. Discarded if it has no level or if its server is not on that node (or no longer exists).
   * `crash_loop`: the agent has stopped and holds the server; the panel sets its desired state to stopped (no new
   * version), so the UI offers “Start” and the next SyncSpecs does not ask for it running.
   */
  ingest(nodeId: string, e: AgentEvent): EventDto | null {
    const level = LEVELS[e.level];
    if (!level) return null;
    const serverId = e.serverId || null;
    let serverName: string | null = null;
    if (serverId) {
      const row = this.app.servers.get(serverId);
      if (!row || row.node_id !== nodeId) return null;
      serverName = row.name;
      if (e.kind === "crash_loop" && row.desired_state === "running") {
        // The event goes through the agent's queue, unordered with respect to the Ack of a “Start”: it only counts if later.
        // With the agent's clock out of range (`agentIso` null) the arrival time is used, which is compared with
        // `desired_changed_at` (panel time): residual effect, an old queued crash_loop arriving after a recent
        // “Start” looks later and stops the server again.
        const at = agentIso(e.tsUnixMs, this.now()) ?? new Date(this.now()).toISOString();
        if (!row.desired_changed_at || at > row.desired_changed_at) this.app.servers.setDesiredState(serverId, "stopped");
      }
    }
    return this.record({ nodeId, serverId, serverName, level, kind: e.kind, message: e.message, agentAt: agentIso(e.tsUnixMs, this.now()) });
  }

  list(q: EventsQuery): EventDto[] {
    return this.repo.list(q).map(toEventDto);
  }

  purge(): number {
    return this.repo.purge(new Date(this.now() - EVENT_RETENTION_DAYS * DAY_MS).toISOString(), MAX_EVENTS);
  }

  start(): void {
    if (this.stopPurge) return;
    this.safePurge();
    this.stopPurge = (this.opts.every ?? defaultEvery)(() => this.safePurge(), PURGE_EVERY_MS);
  }

  stop(): void {
    this.stopPurge?.();
    this.stopPurge = null;
  }

  private safePurge() {
    try {
      this.purge();
    } catch (e) {
      this.app.log.warn({ err: e }, "failed purging old events");
    }
  }
}
