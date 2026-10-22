import type { ConnectAddress } from "@mcsm/shared";
import type { ServerDto } from "./api";

const MINECRAFT_DEFAULT_PORT = 25565;
const ROUTER_DEFAULT_PORT = 25565;

/**
 * What players type in Minecraft to join the server (Settings → Connection address), or null if it can't be
 * known. A server that joins through its node's mc-router uses its own hostname; the rest, the configured host.
 * The port is the external one if configured, else the router's (`routerPort`, null = unknown) or the server's.
 */
export function serverAddress(s: Pick<ServerDto, "spec">, c: ConnectAddress | undefined, routerPort: number | null): string | null {
  const router = s.spec.router?.enabled && s.spec.router.hostname ? s.spec.router.hostname : null;
  const host = router ?? c?.host ?? "";
  if (!host) return null;
  const port = c?.port ?? (router ? routerPort ?? ROUTER_DEFAULT_PORT : s.spec.ports.game);
  return port === MINECRAFT_DEFAULT_PORT ? host : `${host}:${port}`;
}

/**
 * Where to reach the published RCON port, or null if the server does not publish it. The host is the configured
 * connection address host (never the router hostname: mc-router cannot route RCON) and its external port, which belongs
 * to the game, is ignored. Without a configured host it is just the port.
 */
export function rconAddress(s: Pick<ServerDto, "spec">, c: ConnectAddress | undefined): string | null {
  const port = s.spec.ports.rcon;
  if (port === undefined) return null;
  return c?.host ? `${c.host}:${port}` : String(port);
}
