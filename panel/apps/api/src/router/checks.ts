import { specHostPorts, type Spec } from "@mcsm/shared";
import type { ServerRow } from "../servers/repo.js";

/** Server in the list that publishes `port` on the host (game port or extra), if any. Pure. */
export function portOwner(rows: readonly ServerRow[], port: number): ServerRow | null {
  for (const r of rows) {
    const s = JSON.parse(r.spec) as Spec;
    if (specHostPorts(s).includes(port)) return r;
  }
  return null;
}

/** Server in the list (other than `selfId`) with the router enabled and that hostname, if any. Pure. */
export function hostnameOwner(rows: readonly ServerRow[], hostname: string, selfId?: string): ServerRow | null {
  for (const r of rows) {
    if (r.id === selfId) continue;
    const router = (JSON.parse(r.spec) as Spec).router;
    if (router?.enabled && router.hostname === hostname) return r;
  }
  return null;
}
