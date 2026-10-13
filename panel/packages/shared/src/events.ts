import { z } from "zod";

/** Niveles de un evento (Event.level del agente, o del propio panel). */
export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevelName = (typeof EVENT_LEVELS)[number];

/** Tipos válidos (los del agente están en el comentario de `message Event` de agent.proto); otro → "other". */
export const EVENT_KIND_RE = /^[a-z_]{1,32}$/;
export const EVENT_MESSAGE_MAX = 1000;

export const EVENT_KIND_LABEL: Readonly<Record<string, string>> = {
  crash: "Cierre con error",
  oom: "Sin memoria",
  crash_loop: "Bucle de crash",
  crash_loop_failed: "Bucle de crash sin parar",
  drift: "Contenedor recreado",
  save_on_pending: "Guardado automático desactivado",
  save_on_resumed: "Guardado automático reactivado",
  token_rotated: "Token del nodo rotado",
};

export function eventKindLabel(kind: string): string {
  return EVENT_KIND_LABEL[kind] ?? "Otro";
}

export const EVENT_LEVEL_LABEL: Readonly<Record<EventLevelName, string>> = { info: "Información", warn: "Aviso", error: "Error" };

export interface EventDto {
  id: string;
  nodeId: string | null;
  serverId: string | null;
  /** Nombre del servidor cuando ocurrió (el servidor puede haberse borrado). */
  serverName: string | null;
  level: EventLevelName;
  kind: string;
  message: string;
  /** Cuándo lo guardó el panel (orden de la lista). */
  createdAt: string;
  /** Hora del agente, si era razonable. */
  agentAt: string | null;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** GET /api/events: `minLevel` incluye los niveles superiores; `before` pagina por `createdAt`. */
export const eventsQuerySchema = z.object({
  serverId: z.string().min(1).max(64).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  minLevel: z.enum(EVENT_LEVELS).optional(),
  before: z.string().regex(ISO_UTC, "Fecha inválida (ISO 8601 en UTC)").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
