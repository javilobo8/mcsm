import type { QueryClient } from "@tanstack/react-query";
import { ROUTER_DEFAULT_DOWN_AFTER_MINUTES, ROUTER_MAX_DOWN_AFTER_MINUTES, type RouterDeploymentSpec, type RouterDto } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { mergeIntoCached } from "./live";

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
  if (o.state === "running") return { label: `Activo en :${r.spec.port}`, tone: "ok", detail: null };
  return { label: `Estado: ${o.state}`, tone: "warn", detail: null };
}

/** Estado del formulario del router (los números como texto, tal y como se escriben). */
export interface RouterForm { enabled: boolean; port: string; autoscale: boolean; minutes: string }

export function routerFormFrom(spec: RouterDeploymentSpec): RouterForm {
  return { enabled: spec.enabled, port: String(spec.port), autoscale: spec.autoscale, minutes: String(spec.autoscaleDownAfterMinutes) };
}

const intIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/** Errores de campo del formulario (mismas reglas que la API). Vacío = se puede guardar. */
export function routerFormErrors(f: RouterForm): { port?: string; minutes?: string } {
  const out: { port?: string; minutes?: string } = {};
  if (intIn(f.port, 1, 65535) === null) out.port = "Puerto: un número entre 1 y 65535";
  if (f.autoscale && intIn(f.minutes, 1, ROUTER_MAX_DOWN_AFTER_MINUTES) === null) out.minutes = `Minutos: un número entre 1 y ${ROUTER_MAX_DOWN_AFTER_MINUTES}`;
  return out;
}

/** Cuerpo del PUT. Sin autoscale, unos minutos inválidos vuelven al valor por defecto. */
export function routerFormBody(f: RouterForm): RouterDeploymentSpec {
  return {
    enabled: f.enabled, port: intIn(f.port, 1, 65535) ?? 0, autoscale: f.autoscale,
    autoscaleDownAfterMinutes: intIn(f.minutes, 1, ROUTER_MAX_DOWN_AFTER_MINUTES) ?? ROUTER_DEFAULT_DOWN_AFTER_MINUTES,
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
