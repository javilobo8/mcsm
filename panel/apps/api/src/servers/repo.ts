import { create } from "@bufbuild/protobuf";
import { DesiredState, ServerSpecSchema, type ServerSpec } from "@mcsm/proto";
import type { Spec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface ServerRow {
  id: string; node_id: string; name: string; slug: string; spec: string; spec_version: number;
  desired_state: "running" | "stopped"; observed: string | null; observed_spec_version: number;
  observed_at: string | null; created_at: string; updated_at: string;
}

export interface ObservedDto {
  containerId: string; state: string; health: string; startedAtUnix: number; exitCode: number;
  appliedVersion: number; error: string;
  mc: { online: boolean; playersOnline: number; playersMax: number; version: string; latencyMs: number };
}

export interface ServerDto {
  id: string; nodeId: string; name: string; slug: string; spec: Spec | Omit<Spec, "rconPassword">; specVersion: number;
  desiredState: "running" | "stopped"; observed: ObservedDto | null; observedSpecVersion: number; observedAt: string | null;
  createdAt: string; updatedAt: string;
}

export function toServerDto(r: ServerRow, opts: { includeSecrets: boolean } = { includeSecrets: false }): ServerDto {
  const spec = JSON.parse(r.spec) as Spec;
  const { rconPassword: _rconPassword, ...publicSpec } = spec;
  return {
    id: r.id, nodeId: r.node_id, name: r.name, slug: r.slug,
    spec: opts.includeSecrets ? spec : publicSpec,
    specVersion: r.spec_version, desiredState: r.desired_state,
    observed: r.observed ? (JSON.parse(r.observed) as ObservedDto) : null,
    observedSpecVersion: r.observed_spec_version, observedAt: r.observed_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toServerSpecMessage(r: ServerRow): ServerSpec {
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(r.spec),
  });
}

export class ServersRepo {
  constructor(private db: Db) {}

  list(nodeId?: string): ServerRow[] {
    return nodeId
      ? (this.db.prepare("SELECT * FROM servers WHERE node_id = ? ORDER BY name").all(nodeId) as unknown as ServerRow[])
      : (this.db.prepare("SELECT * FROM servers ORDER BY name").all() as unknown as ServerRow[]);
  }
  get(id: string): ServerRow | null {
    return (this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined) ?? null;
  }
  getBySlug(nodeId: string, slug: string): ServerRow | null {
    return (this.db.prepare("SELECT * FROM servers WHERE node_id = ? AND slug = ?").get(nodeId, slug) as ServerRow | undefined) ?? null;
  }
  create(input: { nodeId: string; name: string; slug: string; spec: Spec; desiredState: "running" | "stopped" }): ServerRow {
    const id = newId();
    const now = nowIso();
    this.db.prepare(`INSERT INTO servers (id, node_id, name, slug, spec, spec_version, desired_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, input.nodeId, input.name, input.slug, JSON.stringify(input.spec), input.desiredState, now, now);
    return this.get(id)!;
  }
  /** Guarda la spec nueva, incrementa la versión. */
  updateSpec(id: string, spec: Spec, name?: string): ServerRow {
    this.db.prepare(`UPDATE servers SET spec = ?, spec_version = spec_version + 1, name = COALESCE(?, name), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(spec), name ?? null, nowIso(), id);
    return this.get(id)!;
  }
  /** Solo cambia el nombre: no toca spec_version (no hay nada que enviar al agente). */
  rename(id: string, name: string): ServerRow {
    this.db.prepare("UPDATE servers SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id);
    return this.get(id)!;
  }
  setDesiredState(id: string, state: "running" | "stopped"): void {
    this.db.prepare("UPDATE servers SET desired_state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), id);
  }
  updateObserved(id: string, observed: ObservedDto): void {
    this.db.prepare("UPDATE servers SET observed = ?, observed_spec_version = ?, observed_at = ? WHERE id = ?")
      .run(JSON.stringify(observed), observed.appliedVersion, nowIso(), id);
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  }
  usedGamePorts(nodeId: string): Set<number> {
    const rows = this.db.prepare("SELECT spec FROM servers WHERE node_id = ?").all(nodeId) as unknown as { spec: string }[];
    const used = new Set<number>();
    for (const r of rows) {
      const s = JSON.parse(r.spec) as Spec;
      used.add(s.ports.game);
      for (const e of s.ports.extra) used.add(e.host);
    }
    return used;
  }
}
