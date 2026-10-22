import { create } from "@bufbuild/protobuf";
import { DesiredState, ServerSpecSchema, type ServerSpec } from "@mcsm/proto";
import { specHostPorts, usesCurseForge, type ImportedFrom, type Spec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface ServerRow {
  id: string; node_id: string; name: string; slug: string; spec: string; spec_version: number;
  desired_state: "running" | "stopped"; observed: string | null; observed_spec_version: number;
  observed_at: string | null; created_at: string; updated_at: string;
  /** plan-9: when desired_state last changed (null if never). */
  desired_changed_at?: string | null;
  /** plan-6: ImportedFrom JSON (imported servers). Optional in the type: test rows predating the column. */
  imported_from?: string | null;
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
  /** plan-6: origin of an imported server (null if created by the panel). */
  importedFrom: ImportedFrom | null;
}

export function parseImportedFrom(r: Pick<ServerRow, "imported_from">): ImportedFrom | null {
  return r.imported_from ? (JSON.parse(r.imported_from) as ImportedFrom) : null;
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
    importedFrom: parseImportedFrom(r),
  };
}

/**
 * ServerSpec message for the agent. The global CurseForge API key is added here, only to the
 * specs that use CurseForge: it is not in servers.spec nor in the browser DTOs.
 * `curseforgeApiKey` is required (`app.curseforge.get()`, null if there is none): a sender that
 * forgot it would alternate “with key” and “without key” against SyncSpecs, changing the hash and recreating
 * the container on every send.
 * plan-6: an imported server's spec also carries `adopt: {containerId, version}` (only in the message,
 * never in servers.spec), so that the agent rebuilds a lost adoption without creating a second
 * container over the same world.
 */
export function toServerSpecMessage(r: ServerRow, curseforgeApiKey: string | null): ServerSpec {
  const spec = JSON.parse(r.spec) as Spec;
  const extra: Record<string, unknown> = {};
  if (curseforgeApiKey && usesCurseForge(spec)) extra.curseforgeApiKey = curseforgeApiKey;
  // plan-6: an imported server carries its original container and the adoption version; the agent follows it
  // without recreating it while spec_version does not exceed it, and adopts it again if it lost the record.
  const from = parseImportedFrom(r);
  if (from) extra.adopt = { containerId: from.containerId, version: from.specVersion };
  const json = Object.keys(extra).length > 0 ? JSON.stringify({ ...spec, ...extra }) : r.spec;
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(json),
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
  /** Stores the new spec, increments the version. */
  updateSpec(id: string, spec: Spec, name?: string): ServerRow {
    this.db.prepare(`UPDATE servers SET spec = ?, spec_version = spec_version + 1, name = COALESCE(?, name), updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(spec), name ?? null, nowIso(), id);
    return this.get(id)!;
  }
  /** Only changes the name: does not touch spec_version (there is nothing to send to the agent). */
  rename(id: string, name: string): ServerRow {
    this.db.prepare("UPDATE servers SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id);
    return this.get(id)!;
  }
  /** New version with the same spec (e.g. the CurseForge API key changed): the agent reapplies it. */
  bumpVersion(id: string): ServerRow {
    this.db.prepare("UPDATE servers SET spec_version = spec_version + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
    return this.get(id)!;
  }
  /** plan-6: marks the row as imported (ImportService, right after create). */
  setImportedFrom(id: string, from: ImportedFrom): ServerRow {
    this.db.prepare("UPDATE servers SET imported_from = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(from), nowIso(), id);
    return this.get(id)!;
  }
  setDesiredState(id: string, state: "running" | "stopped"): void {
    const now = nowIso();
    this.db.prepare("UPDATE servers SET desired_state = ?, desired_changed_at = ?, updated_at = ? WHERE id = ?").run(state, now, now, id);
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
      for (const p of specHostPorts(s)) used.add(p);
    }
    return used;
  }
}
