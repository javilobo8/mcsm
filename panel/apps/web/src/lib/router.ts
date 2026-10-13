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

/** Readable status of a node's router from what is saved and what the agent last reported. Pure. */
export function routerStatus(r: RouterDto, nodeOnline: boolean): RouterStatus {
  const o = r.observed;
  if (!r.spec.enabled) {
    if (o?.configured && o.state !== "missing" && nodeOnline) return { label: "Removing…", tone: "warn", detail: null };
    return { label: "Disabled", tone: "muted", detail: null };
  }
  if (!nodeOnline) return { label: "Node offline", tone: "warn", detail: "It will be applied when the node reconnects" };
  if (o?.error) return { label: "Error", tone: "bad", detail: o.error };
  if (!o || !o.configured || o.hostPort !== r.spec.port || o.autoscale !== r.spec.autoscale) return { label: "Applying…", tone: "warn", detail: null };
  if (r.spec.autoscale && (o.autoscaleDownAfterMinutes !== r.spec.autoscaleDownAfterMinutes
    || o.autoscaleAllowPlayers.join("\n") !== r.spec.autoscaleAllowPlayers.join("\n"))) return { label: "Applying…", tone: "warn", detail: null };
  if (o.state === "running") return { label: `Active on :${r.spec.port}`, tone: "ok", detail: null };
  return { label: `State: ${o.state}`, tone: "warn", detail: null };
}

/** State of the router form (numbers and the list as text, as they are typed). */
export interface RouterForm { enabled: boolean; port: string; autoscale: boolean; minutes: string; players: string }

export function routerFormFrom(spec: RouterDeploymentSpec): RouterForm {
  return {
    enabled: spec.enabled, port: String(spec.port), autoscale: spec.autoscale, minutes: String(spec.autoscaleDownAfterMinutes),
    players: spec.autoscaleAllowPlayers.join("\n"),
  };
}

/** Players from the text (one per line or comma-separated), without repeats. */
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
  if (bad.length) return `Invalid player: ${bad.slice(0, 3).join(", ")} (name of 1-16 letters, numbers or _, or UUID)`;
  if (list.length > ROUTER_MAX_ALLOW_PLAYERS) return `At most ${ROUTER_MAX_ALLOW_PLAYERS} players`;
  return undefined;
}

/**
 * Form field errors (same rules as the API). Empty = it can be saved. When disabled
 * there is nothing to validate (m7): disabling can always be saved.
 */
export function routerFormErrors(f: RouterForm): { port?: string; minutes?: string; players?: string } {
  const out: { port?: string; minutes?: string; players?: string } = {};
  if (!f.enabled) return out;
  if (intIn(f.port, 1, 65535) === null) out.port = "Port: a number between 1 and 65535";
  if (f.autoscale && intIn(f.minutes, 1, ROUTER_MAX_DOWN_AFTER_MINUTES) === null) out.minutes = `Minutes: a number between 1 and ${ROUTER_MAX_DOWN_AFTER_MINUTES}`;
  const players = f.autoscale ? playersError(f.players) : undefined;
  if (players) out.players = players;
  return out;
}

/** Body of the PUT. Whatever is not valid (disabled or without autoscale) goes back to what was saved (`saved`). */
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

/** Subset of `Realtime` used here (makes testing easier). */
export interface RouterLiveSource {
  subscribe(topic: string, handler: (msg: ServerMessage) => void): () => void;
  onReconnect(cb: () => void): () => void;
}

/** Keeps ["router", nodeId] up to date with the `nodes` topic. Returns the cleanup function. */
export function bindRouterLive(qc: QueryClient, live: RouterLiveSource, nodeId: string): () => void {
  const offs = [
    live.subscribe("nodes", (m) => { if (m.type === "router" && m.nodeId === nodeId) applyRouterEvent(qc, m); }),
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: routerKey(nodeId) }); }),
  ];
  return () => offs.forEach((off) => off());
}
