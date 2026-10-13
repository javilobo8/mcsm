import { z } from "zod";
import { PLAYER_RE } from "./spec-content.js";

/**
 * Hostname of a server on its node's mc-router: lowercase DNS name (RFC 1123), labels
 * of 1 to 63 [a-z0-9-] characters that neither start nor end with a hyphen, separated by dots, with no trailing
 * dot, max. 253. Same regex as the agent (hostnameRe in agent/internal/spec/router.go; fixture
 * proto/fixtures/router-hostname-cases.json).
 */
export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const MAX_HOSTNAME_LEN = 253;

export function validHostname(h: string): boolean {
  return h.length <= MAX_HOSTNAME_LEN && HOSTNAME_RE.test(h);
}

/** Message for an invalid hostname; null if valid (empty = no hostname, decided by the schema). */
export function hostnameError(h: string): string | null {
  if (h === "" || validHostname(h)) return null;
  if (h !== h.toLowerCase()) return "The hostname must be lowercase";
  if (h.length > MAX_HOSTNAME_LEN) return `The hostname cannot exceed ${MAX_HOSTNAME_LEN} characters`;
  return "Invalid hostname: lowercase letters, numbers, hyphens and dots (e.g. survival.lan)";
}

/**
 * `router` section of a server's spec (plan-8): join through the node's mc-router by `hostname`. When
 * enabled it requires a hostname. The agent adds the `mc-router.host`/`mc-router.network` labels
 * to the container (enabling it, disabling it or changing the hostname recreates the container).
 */
export const serverRouterSchema = z
  .object({
    enabled: z.boolean().default(false),
    hostname: z.string().default("").superRefine((h, ctx) => {
      const msg = hostnameError(h);
      if (msg) ctx.addIssue({ code: "custom", message: msg });
    }),
  })
  .refine((r) => !r.enabled || r.hostname !== "", { message: "Specify the hostname to join through the router", path: ["hostname"] });
export type ServerRouter = z.infer<typeof serverRouterSchema>;

export const ROUTER_DEFAULT_PORT = 25565;
export const ROUTER_DEFAULT_DOWN_AFTER_MINUTES = 10;
export const ROUTER_MAX_DOWN_AFTER_MINUTES = 1440;
/** Cap on the list of players that wake servers (like the spec's lists). */
export const ROUTER_MAX_ALLOW_PLAYERS = 1000;

/** Configuration of a node's mc-router (`router_deployments.spec`). */
export const routerDeploymentSpecSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(ROUTER_DEFAULT_PORT),
  autoscale: z.boolean().default(false),
  autoscaleDownAfterMinutes: z.number().int().min(1).max(ROUTER_MAX_DOWN_AFTER_MINUTES).default(ROUTER_DEFAULT_DOWN_AFTER_MINUTES),
  /**
   * With autoscale, only these players (profile name or UUID, like the whitelist) wake a
   * sleeping server or cancel its stop (`-auto-scale-allow-deny`). Empty = anyone who reaches
   * the port. Changing it recreates the router (mc-router does not reread the list).
   */
  autoscaleAllowPlayers: z.array(z.string().regex(PLAYER_RE, "Invalid player: name of 1-16 letters, numbers or _, or UUID"))
    .max(ROUTER_MAX_ALLOW_PLAYERS).default([]),
});
export type RouterDeploymentSpec = z.infer<typeof routerDeploymentSpecSchema>;

export function defaultRouterDeploymentSpec(): RouterDeploymentSpec {
  return routerDeploymentSpecSchema.parse({});
}

/**
 * The agent's latest RouterObserved (proto `RouterObserved`, without the ts). `autoscaleDownAfterMinutes` and
 * `autoscaleAllowPlayers` are those of the spec stored on the agent (0 and [] without a spec).
 */
export interface RouterObservedDto {
  configured: boolean; state: string; containerId: string; image: string; hostPort: number; autoscale: boolean; error: string;
  autoscaleDownAfterMinutes: number; autoscaleAllowPlayers: string[];
}

/** A node's router as served by `GET/PUT /api/nodes/:id/router` and the WS `router` event. */
export interface RouterDto {
  nodeId: string; spec: RouterDeploymentSpec; observed: RouterObservedDto | null; observedAt: string | null; updatedAt: string | null;
}
