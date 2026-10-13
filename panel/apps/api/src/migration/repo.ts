import type { MigrationDto, MigrationPhase, Spec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { nowIso } from "../lib/time.js";
import type { ObservedDto } from "../servers/repo.js";

export interface MigrationRow {
  id: string; server_id: string; source_node_id: string; target_node_id: string; source_slug: string; target_slug: string;
  source_version: number; target_version: number; target_port: number; target_spec: string;
  was_running: number; delete_source: number; phase: MigrationPhase;
  /** The target may already hold something of this migration (MigrateReceive was sent): undoing requires MigrateAbort. */
  target_touched: number;
  /** The target received the start command: the source does not start again until the target is clean. */
  target_started: number;
  /** rolling_back: the source still has to be started. committed: it still has to be removed. */
  source_pending: number;
  /** rolling_back: MigrateAbort is missing on the target. */
  target_pending: number;
  /** committed: MigrateConfirm is missing on the target. */
  target_confirm_pending: number;
  error: string | null;
  /** Last failure of what is pending, or why retrying stopped (definitive rejection or manual close). */
  pending_error: string | null;
  created_at: string; updated_at: string;
}

export type NewMigration = Pick<MigrationRow,
  "id" | "server_id" | "source_node_id" | "target_node_id" | "source_slug" | "target_slug" | "source_version" | "target_version" |
  "target_port" | "target_spec" | "was_running" | "delete_source">;
export type MigrationPatch = Partial<Pick<MigrationRow,
  "phase" | "target_touched" | "target_started" | "source_pending" | "target_pending" | "target_confirm_pending" | "error" | "pending_error">>;

const OPEN = "('running', 'rolling_back', 'committed')";
/**
 * There may be a conflict with what the user does on the server: the steps are in progress, or it is rolling back and the source
 * still has to be started (done by the migration) or a target copy that did start has to be cleaned up (the source must not
 * start until then). Only with the cleanup of a target that never started pending is the server already usable.
 */
const SERVER_BLOCKING = `(phase = 'running' OR (phase = 'rolling_back' AND (source_pending = 1 OR (target_started = 1 AND target_pending = 1))))`;
/** The target may hold something of the migration: steps in progress or cleanup pending. */
const TARGET_BUSY = `(phase = 'running' OR (phase = 'rolling_back' AND target_pending = 1))`;
const PATCHABLE = ["phase", "target_touched", "target_started", "source_pending", "target_pending", "target_confirm_pending", "error", "pending_error"] as const;
/** Phases after the commit: the server now belongs to the target. */
const CONFIRMED: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["committed", "done"]);
/** Phases a confirmed migration cannot go back to. */
const REVERTING: ReadonlySet<MigrationPhase> = new Set<MigrationPhase>(["running", "rolling_back", "failed"]);

export function toMigrationDto(r: MigrationRow): MigrationDto {
  return {
    id: r.id, serverId: r.server_id, sourceNodeId: r.source_node_id, targetNodeId: r.target_node_id,
    sourceSlug: r.source_slug, targetSlug: r.target_slug, targetPort: r.target_port, targetVersion: r.target_version,
    wasRunning: r.was_running === 1, deleteSource: r.delete_source === 1, phase: r.phase,
    sourcePending: r.source_pending === 1, targetPending: r.target_pending === 1, targetStarted: r.target_started === 1,
    targetConfirmPending: r.target_confirm_pending === 1, error: r.error, pendingError: r.pending_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Host ports of a spec: the game port and the extras. */
const specPorts = (spec: Spec): number[] => [spec.ports.game, ...spec.ports.extra.map((e) => e.host)];

export class MigrationsRepo {
  constructor(private db: Db) {}

  private one(sql: string, ...args: string[]): MigrationRow | null {
    return (this.db.prepare(sql).get(...args) as MigrationRow | undefined) ?? null;
  }

  insert(m: NewMigration): MigrationRow {
    const now = nowIso();
    this.db.prepare(`INSERT INTO migrations (id, server_id, source_node_id, target_node_id, source_slug, target_slug, source_version,
        target_version, target_port, target_spec, was_running, delete_source, phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(m.id, m.server_id, m.source_node_id, m.target_node_id, m.source_slug, m.target_slug, m.source_version,
        m.target_version, m.target_port, m.target_spec, m.was_running, m.delete_source, now, now);
    return this.get(m.id)!;
  }

  get(id: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE id = ?", id);
  }

  latestForServer(serverId: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE server_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", serverId);
  }

  openForServer(serverId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND phase IN ${OPEN} ORDER BY created_at DESC LIMIT 1`, serverId);
  }

  listOpen(): MigrationRow[] {
    return this.db.prepare(`SELECT * FROM migrations WHERE phase IN ${OPEN} ORDER BY created_at, id`).all() as unknown as MigrationRow[];
  }

  /**
   * Changes fields of the migration. A confirmed migration (committed or done) never goes back: the server already
   * lives on the target and undoing (MigrateAbort) would delete it. Requesting it is a bug and throws without touching anything.
   */
  update(id: string, patch: MigrationPatch): MigrationRow {
    if ((patch.phase !== undefined && REVERTING.has(patch.phase)) || patch.target_pending === 1) {
      const cur = this.get(id);
      if (cur && CONFIRMED.has(cur.phase)) throw new Error(`migration ${id} already confirmed (${cur.phase}): it cannot be undone`);
    }
    const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
    if (keys.length > 0) {
      this.db.prepare(`UPDATE migrations SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => patch[k] as string | number | null), nowIso(), id);
    }
    return this.get(id)!;
  }

  /** Blocks user actions on the server while they can clash with the migration (SERVER_BLOCKING). */
  blockingServer(serverId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND ${SERVER_BLOCKING} ORDER BY created_at DESC LIMIT 1`, serverId);
  }

  /** Blocks creating servers on the node: target with something of the migration, or source with the removal pending (its slug). */
  blockingNodeCreate(nodeId: string): MigrationRow | null {
    return this.one(`SELECT * FROM migrations WHERE (target_node_id = ? AND ${TARGET_BUSY}) OR (source_node_id = ? AND phase = 'committed' AND source_pending = 1)
      ORDER BY created_at LIMIT 1`, nodeId, nodeId);
  }

  /**
   * Host ports reserved on `nodeId` by the migrations towards it that may still have (or soon have) their
   * copy there: the game port and the extras of their spec on the target. `checkPorts`/`allocatePort` count them as
   * used. After the commit it is no longer needed: the server's row is on the node.
   */
  reservedPorts(nodeId: string, exceptServerId?: string): Set<number> {
    const out = new Set<number>();
    for (const m of this.incoming(nodeId, exceptServerId)) for (const p of specPorts(m.spec)) out.add(p);
    return out;
  }

  /**
   * Server and spec on the target of the migrations towards `nodeId` that may still have (or soon have) their
   * copy there (like `reservedPorts`). Plan 8: their router hostnames are also taken on that node.
   */
  incoming(nodeId: string, exceptServerId?: string): { serverId: string; spec: Spec }[] {
    const rows = this.db.prepare(`SELECT server_id, target_spec FROM migrations WHERE target_node_id = ? AND ${TARGET_BUSY}`)
      .all(nodeId) as unknown as { server_id: string; target_spec: string }[];
    return rows.filter((r) => r.server_id !== exceptServerId).map((r) => ({ serverId: r.server_id, spec: JSON.parse(r.target_spec) as Spec }));
  }

  /** Open migrations (in progress, rolling back or with work pending after the commit) whose source is `nodeId`. */
  openFrom(nodeId: string): MigrationRow[] {
    return this.listOpen().filter((m) => m.source_node_id === nodeId);
  }

  /** Blocks deleting the node while a migration that uses it is in progress (while rolling back, it is allowed). */
  blockingNodeDelete(nodeId: string): MigrationRow | null {
    return this.one("SELECT * FROM migrations WHERE phase = 'running' AND (source_node_id = ? OR target_node_id = ?) ORDER BY created_at LIMIT 1", nodeId, nodeId);
  }

  /** SyncSpecs does not remove from `nodeId` a server with an open migration going through that node. */
  protects(nodeId: string, serverId: string): boolean {
    return this.one(`SELECT * FROM migrations WHERE server_id = ? AND phase IN ${OPEN} AND (source_node_id = ? OR target_node_id = ?) LIMIT 1`,
      serverId, nodeId, nodeId) !== null;
  }

  /**
   * A step failed: the migration starts rolling back, with the pending work according to what it got to do, ONLY if it is still
   * in progress (`running`). If it was already confirmed (the commit is a transaction that changes the phase), returns null and
   * changes nothing: after the commit it is never rolled back (MigrateAbort would delete the live server on the target).
   */
  startRollback(id: string, error: string): MigrationRow | null {
    const r = this.db.prepare(`UPDATE migrations SET phase = 'rolling_back', target_pending = target_touched, source_pending = was_running,
      error = ?, updated_at = ? WHERE id = ? AND phase = 'running'`).run(error, nowIso(), id);
    return Number(r.changes) === 1 ? this.get(id) : null;
  }

  /** When the panel starts: what was in progress starts rolling back, with the pending work according to what it got to do. */
  interruptRunning(message: string): MigrationRow[] {
    const rows = this.db.prepare("SELECT id FROM migrations WHERE phase = 'running' ORDER BY created_at").all() as unknown as { id: string }[];
    const now = nowIso();
    const stmt = this.db.prepare(`UPDATE migrations SET phase = 'rolling_back', target_pending = target_touched, source_pending = was_running,
      error = COALESCE(error, ?), updated_at = ? WHERE id = ? AND phase = 'running'`);
    for (const r of rows) stmt.run(message, now, r.id);
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * Confirms the migration in ONE transaction: the server's row moves to the target (node, slug, spec, version, desired
   * state and last observed) only if it is still on the source with the starting version, and the migration becomes
   * `committed` with the removal of the source and the confirmation on the target pending. Returns false (changing nothing) if the version changed, or the
   * slug or any of its ports is already taken on the target.
   */
  commit(m: MigrationRow, desired: "running" | "stopped", observed: ObservedDto | null): boolean {
    const now = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The server's ports on the target are still free there (another server on that node may have changed its own).
      const mine = new Set(specPorts(JSON.parse(m.target_spec) as Spec));
      const others = this.db.prepare("SELECT spec FROM servers WHERE node_id = ? AND id != ?").all(m.target_node_id, m.server_id) as unknown as { spec: string }[];
      if (others.some((r) => specPorts(JSON.parse(r.spec) as Spec).some((p) => mine.has(p)))) {
        this.db.exec("ROLLBACK");
        return false;
      }
      // imported_from = NULL (Plan 6): on the target the server no longer follows any original container (no `adopt`).
      const moved = this.db.prepare(`UPDATE servers SET node_id = ?, slug = ?, spec = ?, spec_version = ?, desired_state = ?, desired_changed_at = ?,
          observed = ?, observed_spec_version = ?, observed_at = ?, updated_at = ?, imported_from = NULL
        WHERE id = ? AND node_id = ? AND spec_version = ?`)
        .run(m.target_node_id, m.target_slug, m.target_spec, m.target_version, desired, now,
          observed ? JSON.stringify(observed) : null, m.target_version, observed ? now : null, now,
          m.server_id, m.source_node_id, m.source_version);
      const done = this.db.prepare(`UPDATE migrations SET phase = 'committed', source_pending = 1, target_confirm_pending = 1, error = NULL,
          updated_at = ? WHERE id = ? AND phase = 'running'`)
        .run(now, m.id);
      if (Number(moved.changes) !== 1 || Number(done.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) return false;
      throw e;
    }
  }
}
