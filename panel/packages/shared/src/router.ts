import { z } from "zod";
import { PLAYER_RE } from "./spec-content.js";

/**
 * Hostname de un servidor en el mc-router de su nodo: nombre DNS en minúsculas (RFC 1123), etiquetas
 * de 1 a 63 caracteres [a-z0-9-] que no empiezan ni acaban por guion, separadas por puntos, sin punto
 * final, máx. 253. Misma regex que el agente (hostnameRe en agent/internal/spec/router.go; fixture
 * proto/fixtures/router-hostname-cases.json).
 */
export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const MAX_HOSTNAME_LEN = 253;

export function validHostname(h: string): boolean {
  return h.length <= MAX_HOSTNAME_LEN && HOSTNAME_RE.test(h);
}

/** Mensaje para un hostname inválido; null si vale (vacío = sin hostname, lo decide el esquema). */
export function hostnameError(h: string): string | null {
  if (h === "" || validHostname(h)) return null;
  if (h !== h.toLowerCase()) return "El hostname va en minúsculas";
  if (h.length > MAX_HOSTNAME_LEN) return `El hostname no puede pasar de ${MAX_HOSTNAME_LEN} caracteres`;
  return "Hostname inválido: letras minúsculas, números, guiones y puntos (p. ej. survival.lan)";
}

/**
 * Sección `router` de la spec de un servidor (plan-8): entrar por `hostname` a través del mc-router del
 * nodo. Activada exige hostname. El agente añade las etiquetas `mc-router.host`/`mc-router.network`
 * al contenedor (activarla, desactivarla o cambiar el hostname recrea el contenedor).
 */
export const serverRouterSchema = z
  .object({
    enabled: z.boolean().default(false),
    hostname: z.string().default("").superRefine((h, ctx) => {
      const msg = hostnameError(h);
      if (msg) ctx.addIssue({ code: "custom", message: msg });
    }),
  })
  .refine((r) => !r.enabled || r.hostname !== "", { message: "Indica el hostname para entrar por el router", path: ["hostname"] });
export type ServerRouter = z.infer<typeof serverRouterSchema>;

export const ROUTER_DEFAULT_PORT = 25565;
export const ROUTER_DEFAULT_DOWN_AFTER_MINUTES = 10;
export const ROUTER_MAX_DOWN_AFTER_MINUTES = 1440;
/** Tope de la lista de jugadores que despiertan servidores (como las listas de la spec). */
export const ROUTER_MAX_ALLOW_PLAYERS = 1000;

/** Configuración del mc-router de un nodo (`router_deployments.spec`). */
export const routerDeploymentSpecSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(ROUTER_DEFAULT_PORT),
  autoscale: z.boolean().default(false),
  autoscaleDownAfterMinutes: z.number().int().min(1).max(ROUTER_MAX_DOWN_AFTER_MINUTES).default(ROUTER_DEFAULT_DOWN_AFTER_MINUTES),
  /**
   * Con autoscale, solo estos jugadores (nombre de perfil o UUID, como la whitelist) despiertan un
   * servidor dormido o cancelan su parada (`-auto-scale-allow-deny`). Vacía = cualquiera que llegue
   * al puerto. Cambiarla recrea el router (mc-router no relee la lista).
   */
  autoscaleAllowPlayers: z.array(z.string().regex(PLAYER_RE, "Jugador inválido: nombre de 1-16 letras, números o _, o UUID"))
    .max(ROUTER_MAX_ALLOW_PLAYERS).default([]),
});
export type RouterDeploymentSpec = z.infer<typeof routerDeploymentSpecSchema>;

export function defaultRouterDeploymentSpec(): RouterDeploymentSpec {
  return routerDeploymentSpecSchema.parse({});
}

/**
 * Último RouterObserved del agente (proto `RouterObserved`, sin el ts). `autoscaleDownAfterMinutes` y
 * `autoscaleAllowPlayers` son los de la spec guardada en el agente (0 y [] sin spec).
 */
export interface RouterObservedDto {
  configured: boolean; state: string; containerId: string; image: string; hostPort: number; autoscale: boolean; error: string;
  autoscaleDownAfterMinutes: number; autoscaleAllowPlayers: string[];
}

/** Router de un nodo tal y como lo sirve `GET/PUT /api/nodes/:id/router` y el evento `router` del WS. */
export interface RouterDto {
  nodeId: string; spec: RouterDeploymentSpec; observed: RouterObservedDto | null; observedAt: string | null; updatedAt: string | null;
}
