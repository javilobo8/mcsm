import type { Spec } from "@mcsm/shared";
import type { ServerRow } from "../servers/repo.js";

/** Servidor de la lista que publica `port` en el host (puerto de juego o extra), si lo hay. Pura. */
export function portOwner(rows: readonly ServerRow[], port: number): ServerRow | null {
  for (const r of rows) {
    const s = JSON.parse(r.spec) as Spec;
    if (s.ports.game === port || s.ports.extra.some((e) => e.host === port)) return r;
  }
  return null;
}

/** Servidor de la lista (distinto de `selfId`) con el router activo y ese hostname, si lo hay. Pura. */
export function hostnameOwner(rows: readonly ServerRow[], hostname: string, selfId?: string): ServerRow | null {
  for (const r of rows) {
    if (r.id === selfId) continue;
    const router = (JSON.parse(r.spec) as Spec).router;
    if (router?.enabled && router.hostname === hostname) return r;
  }
  return null;
}
