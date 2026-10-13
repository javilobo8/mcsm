import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export type BackupTriggerName = "manual" | "scheduled" | "pre_migration" | "pre_restore";
export type BackupStatus = "running" | "ok" | "failed" | "deleted";

export interface BackupRow {
  id: string; server_id: string; node_id: string; filename: string; size_bytes: number; sha256: string;
  spec_version: number; trigger: BackupTriggerName; status: BackupStatus; started_at: string;
  finished_at: string | null; error: string | null; created_at: string;
}

export interface BackupDto {
  id: string; serverId: string; nodeId: string; filename: string; sizeBytes: number; sha256: string;
  specVersion: number; trigger: BackupTriggerName; status: BackupStatus; startedAt: string; finishedAt: string | null;
  /** "directory": data kept before a restore (not a .tar.zst). */
  kind: "archive" | "directory";
}

/** A backup as described by the agent. */
export interface BackupInput {
  serverId: string; filename: string; sizeBytes: number; sha256: string; specVersion: number;
  trigger: BackupTriggerName; startedAt: string; finishedAt: string | null;
}

export function toBackupDto(r: BackupRow): BackupDto {
  return {
    id: r.id, serverId: r.server_id, nodeId: r.node_id, filename: r.filename, sizeBytes: r.size_bytes, sha256: r.sha256,
    specVersion: r.spec_version, trigger: r.trigger, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
    kind: r.trigger === "pre_restore" ? "directory" : "archive",
  };
}

export class BackupsRepo {
  constructor(private db: Db) {}

  /** Inserts or updates (by server + file) a backup that exists on the node. */
  upsertOk(nodeId: string, b: BackupInput): BackupRow {
    this.db.prepare(`INSERT INTO backups (id, server_id, node_id, filename, size_bytes, sha256, spec_version, trigger, status, started_at, finished_at, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, NULL, ?)
      ON CONFLICT(server_id, filename) DO UPDATE SET node_id = excluded.node_id, size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256, spec_version = excluded.spec_version, trigger = excluded.trigger, status = 'ok',
        started_at = excluded.started_at, finished_at = excluded.finished_at, error = NULL`)
      .run(newId(), b.serverId, nodeId, b.filename, b.sizeBytes, b.sha256, b.specVersion, b.trigger, b.startedAt, b.finishedAt, nowIso());
    return this.getByName(b.serverId, b.filename)!;
  }

  get(id: string): BackupRow | null {
    return (this.db.prepare("SELECT * FROM backups WHERE id = ?").get(id) as BackupRow | undefined) ?? null;
  }

  getByName(serverId: string, filename: string): BackupRow | null {
    return (this.db.prepare("SELECT * FROM backups WHERE server_id = ? AND filename = ?").get(serverId, filename) as BackupRow | undefined) ?? null;
  }

  /** Current backups of a server, most recent first. */
  list(serverId: string): BackupRow[] {
    return this.db.prepare("SELECT * FROM backups WHERE server_id = ? AND status != 'deleted' ORDER BY started_at DESC, filename DESC")
      .all(serverId) as unknown as BackupRow[];
  }

  markDeleted(serverId: string, filename: string): boolean {
    const r = this.db.prepare("UPDATE backups SET status = 'deleted' WHERE server_id = ? AND filename = ? AND status != 'deleted'").run(serverId, filename);
    return Number(r.changes) > 0;
  }

  /**
   * Marks as deleted the current backups of a server that the node no longer has. Only those the panel already knew
   * before `createdBefore` (when it requested the inventory): a backup announced later may have been created after
   * the agent listed the disk.
   */
  markMissingDeleted(serverId: string, present: ReadonlySet<string>, createdBefore: string): number {
    const rows = this.db.prepare("SELECT filename FROM backups WHERE server_id = ? AND status = 'ok' AND created_at < ?")
      .all(serverId, createdBefore) as unknown as { filename: string }[];
    let n = 0;
    for (const r of rows) {
      if (!present.has(r.filename) && this.markDeleted(serverId, r.filename)) n++;
    }
    return n;
  }
}
