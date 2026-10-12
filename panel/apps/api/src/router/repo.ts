import { defaultRouterDeploymentSpec, routerDeploymentSpecSchema, type RouterDeploymentSpec, type RouterDto, type RouterObservedDto } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { nowIso } from "../lib/time.js";

export interface RouterRow {
  node_id: string; spec: string; observed: string | null; observed_at: string | null; updated_at: string | null;
}

/** Spec guardada de la fila (la por defecto, desactivada, si no hay fila). */
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

  /** Guarda la configuración del usuario (crea la fila si no existe). */
  upsertSpec(nodeId: string, spec: RouterDeploymentSpec): RouterRow {
    this.db.prepare(`INSERT INTO router_deployments (node_id, spec, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`)
      .run(nodeId, JSON.stringify(spec), nowIso());
    return this.get(nodeId)!;
  }

  /** Guarda el último estado observado (crea la fila, desactivada, si no existe). */
  setObserved(nodeId: string, observed: RouterObservedDto): RouterRow {
    this.db.prepare(`INSERT INTO router_deployments (node_id, spec, observed, observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET observed = excluded.observed, observed_at = excluded.observed_at`)
      .run(nodeId, JSON.stringify(defaultRouterDeploymentSpec()), JSON.stringify(observed), nowIso());
    return this.get(nodeId)!;
  }
}
