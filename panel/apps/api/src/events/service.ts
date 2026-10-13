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
  /** Reloj en ms (tests). */
  now?: () => number;
  /** Repite `fn` cada `ms` y devuelve la función que lo cancela (tests). */
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

/** Incidencias de los agentes (Event, spec §5.3) y del panel: tabla `events`, topic `events` del WS. */
export class EventsService {
  private stopPurge: Cancel | null = null;
  private now: () => number;

  constructor(private app: FastifyInstance, private repo: EventsRepo, private opts: EventsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Guarda un evento y lo publica (`server_event` → topic `events`). */
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
   * Event no solicitado de un agente. Se descarta si no trae nivel o si su servidor no es de ese nodo (o ya no existe).
   * `crash_loop`: el agente ha parado y retiene el servidor; el panel pone su estado deseado en parado (sin versión
   * nueva), así la UI ofrece «Arrancar» y el siguiente SyncSpecs no lo pide en marcha.
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
        // El evento sale por la cola del agente, sin orden respecto al Ack de un «Arrancar»: solo cuenta si es posterior.
        // Con el reloj del agente fuera de rango (`agentIso` null) se usa la hora de llegada, que se compara con
        // `desired_changed_at` (hora del panel): efecto residual, un crash_loop viejo y encolado que llegue tras un
        // «Arrancar» reciente parece posterior y vuelve a parar el servidor.
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
      this.app.log.warn({ err: e }, "fallo purgando eventos antiguos");
    }
  }
}
