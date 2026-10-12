import type { QueryClient } from "@tanstack/react-query";
import {
  PLAYER_RE, ROUTER_MAX_ALLOW_PLAYERS, ROUTER_MAX_DOWN_AFTER_MINUTES, type RouterDeploymentSpec, type RouterDto,
} from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { mergeIntoCached } from "./live";
import { parseList } from "./spec-edit";

export const routerKey = (nodeId: string) => ["router", nodeId] as const;

export type RouterTone = "ok" | "warn" | "bad" | "muted";
export interface RouterStatus { label: string; tone: RouterTone; detail: string | null }

/** Estado legible del router de un nodo a partir de lo guardado y lo último que informó el agente. Pura. */
export function routerStatus(r: RouterDto, nodeOnline: boolean): RouterStatus {
  const o = r.observed;
  if (!r.spec.enabled) {
    if (o?.configured && o.state !== "missing" && nodeOnline) return { label: "Retirando…", tone: "warn", detail: null };
    return { label: "Desactivado", tone: "muted", detail: null };
  }
  if (!nodeOnline) return { label: "Nodo desconectado", tone: "warn", detail: "Se aplicará cuando el nodo vuelva a conectar" };
  if (o?.error) return { label: "Error", tone: "bad", detail: o.error };
  if (!o || !o.configured || o.hostPort !== r.spec.port || o.autoscale !== r.spec.autoscale) return { label: "Aplicando…", tone: "warn", detail: null };
  if (r.spec.autoscale && (o.autoscaleDownAfterMinutes !== r.spec.autoscaleDownAfterMinutes
    || o.autoscaleAllowPlayers.join("\n") !== r.spec.autoscaleAllowPlayers.join("\n"))) return { label: "Aplicando…", tone: "warn", detail: null };
  if (o.state === "running") return { label: `Activo en :${r.spec.port}`, tone: "ok", detail: null };
  return { label: `Estado: ${o.state}`, tone: "warn", detail: null };
}

/** Estado del formulario del router (los números y la lista como texto, tal y como se escriben). */
export interface RouterForm { enabled: boolean; port: string; autoscale: boolean; minutes: string; players: string }

export function routerFormFrom(spec: RouterDeploymentSpec): RouterForm {
  return {
    enabled: spec.enabled, port: String(spec.port), autoscale: spec.autoscale, minutes: String(spec.autoscaleDownAfterMinutes),
    players: spec.autoscaleAllowPlayers.join("\n"),
  };
}

/** Jugadores del texto (uno por línea o separados por comas), sin repetir. */
const playersOf = (text: string): string[] => [...new Set(parseList(text))];

const intIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

function playersError(text: string): string | undefined {
  const list = playersOf(text);
  const bad = list.filter((p) => !PLAYER_RE.test(p));
  if (bad.length) return `Jugador inválido: ${bad.slice(0, 3).join(", ")} (nombre de 1-16 letras, números o _, o UUID)`;
  if (list.length > ROUTER_MAX_ALLOW_PLAYERS) return `Como mucho ${ROUTER_MAX_ALLOW_PLAYERS} jugadores`;
  return undefined;
}

/**
 * Errores de campo del formulario (mismas reglas que la API). Vacío = se puede guardar. Desactivado
 * no hay nada que validar (m7): desactivar siempre se puede guardar.
 */
export function routerFormErrors(f: RouterForm): { port?: string; minutes?: string; players?: string } {
  const out: { port?: string; minutes?: string; players?: string } = {};
  if (!f.enabled) return out;
  if (intIn(f.port, 1, 65535) === null) out.port = "Puerto: un número entre 1 y 65535";
  if (f.autoscale && intIn(f.minutes, 1, ROUTER_MAX_DOWN_AFTER_MINUTES) === null) out.minutes = `Minutos: un número entre 1 y ${ROUTER_MAX_DOWN_AFTER_MINUTES}`;
  const players = f.autoscale ? playersError(f.players) : undefined;
  if (players) out.players = players;
  return out;
}

/** Cuerpo del PUT. Lo que no valga (desactivado o sin autoscale) vuelve a lo guardado (`saved`). */
export function routerFormBody(f: RouterForm, saved: RouterDeploymentSpec): RouterDeploymentSpec {
  return {
    enabled: f.enabled, port: intIn(f.port, 1, 65535) ?? saved.port, autoscale: f.autoscale,
    autoscaleDownAfterMinutes: intIn(f.minutes, 1, ROUTER_MAX_DOWN_AFTER_MINUTES) ?? saved.autoscaleDownAfterMinutes,
    autoscaleAllowPlayers: playersError(f.players) ? saved.autoscaleAllowPlayers : playersOf(f.players),
  };
}

type RouterMsg = Extract<ServerMessage, { type: "router" }>;

export function applyRouterEvent(qc: QueryClient, msg: RouterMsg): void {
  mergeIntoCached<RouterDto>(qc, routerKey(msg.nodeId), () => msg.router);
}

/** Subconjunto de `Realtime` que se usa aquí (facilita los tests). */
export interface RouterLiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

/** Mantiene ["router", nodeId] al día con el topic `nodes`. Devuelve la función de limpieza. */
export function bindRouterLive(qc: QueryClient, live: RouterLiveSource, nodeId: string): () => void {
  const offs = [
    live.subscribe("nodes", (m) => { if (m.type === "router" && m.nodeId === nodeId) applyRouterEvent(qc, m); }),
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: routerKey(nodeId) }); }),
  ];
  return () => offs.forEach((off) => off());
}
