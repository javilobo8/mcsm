import { defaultRouterDeploymentSpec, routerDeploymentSpecSchema, type RouterDeploymentSpec, type RouterDto, type RouterObservedDto } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { nowIso } from "../lib/time.js";

export interface RouterRow {
  node_id: string; spec: string; observed: string | null; observed_at: string | null; updated_at: string | null;
}

/** The row's stored spec (the default, disabled, if there is no row). */
export function rowSpec(r: RouterRow | null): RouterDeploymentSpec {
  return r ? routerDeploymentSpecSchema.parse(JSON.parse(r.spec)) : defaultRouterDeploymentSpec();
}

export function toRouterDto(nodeId: string, r: RouterRow | null): RouterDto {
  return {
    nodeId, spec: rowSpec(r),
    observed: r?.observed ? (JSON.parse(r.observed) as RouterObservedDto) : null,
    observedAt: r?.observed_at ?? null, updatedAt: r?.updated_at ?? null,
  };
}

export class RouterRepo {
  constructor(private db: Db) {}

  get(nodeId: string): RouterRow | null {
    return (this.db.prepare("SELECT * FROM router_deployments WHERE node_id = ?").get(nodeId) as RouterRow | undefined) ?? null;
  }

  /** Stores the user's configuration (creates the row if it does not exist). */
  upsertSpec(nodeId: string, spec: RouterDeploymentSpec): RouterRow {
    this.db.prepare(`INSERT INTO router_deployments (node_id, spec, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`)
      .run(nodeId, JSON.stringify(spec), nowIso());
    return this.get(nodeId)!;
  }

  /**
   * Undoes an `upsertSpec` (`written`) by going back to the previous row (`before`; without it, not
   * configured), only if nobody has changed it since. Returns whether it undid it.
   */
  revert(nodeId: string, before: RouterRow | null, written: RouterRow): boolean {
    const res = before
      ? this.db.prepare("UPDATE router_deployments SET spec = ?, updated_at = ? WHERE node_id = ? AND spec = ? AND updated_at IS ?")
        .run(before.spec, before.updated_at, nodeId, written.spec, written.updated_at)
      : this.db.prepare("UPDATE router_deployments SET spec = ?, updated_at = NULL WHERE node_id = ? AND spec = ? AND updated_at IS ?")
        .run(JSON.stringify(defaultRouterDeploymentSpec()), nodeId, written.spec, written.updated_at);
    return Number(res.changes) > 0;
  }

  /** Stores the last observed state (creates the row, disabled, if it does not exist). */
  setObserved(nodeId: string, observed: RouterObservedDto): RouterRow {
    this.db.prepare(`INSERT INTO router_deployments (node_id, spec, observed, observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET observed = excluded.observed, observed_at = excluded.observed_at`)
      .run(nodeId, JSON.stringify(defaultRouterDeploymentSpec()), JSON.stringify(observed), nowIso());
    return this.get(nodeId)!;
  }
}
