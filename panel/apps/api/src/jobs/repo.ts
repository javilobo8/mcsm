import type { Db } from "../db/db.js";

export type JobState = "queued" | "running" | "ok" | "failed" | "cancelled";

export interface JobRow {
  id: string; type: string; server_id: string | null; node_id: string | null; status: JobState;
  progress: number; message: string; log: string; payload: string;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}

export interface JobDto {
  id: string; type: string; serverId: string | null; nodeId: string | null; status: JobState;
  progress: number; message: string; payload: Record<string, unknown>;
  createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
}

/** Detalle con el log (los listados no lo llevan: puede ocupar 256 KiB). */
export interface JobDetailDto extends JobDto { log: string }

export interface JobListFilter { serverId?: string; status?: JobState; limit?: number; before?: string }

export function toJobDto(r: JobRow): JobDto {
  return {
    id: r.id, type: r.type, serverId: r.server_id, nodeId: r.node_id, status: r.status, progress: r.progress,
    message: r.message, payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

export function toJobDetailDto(r: JobRow): JobDetailDto {
  return { ...toJobDto(r), log: r.log };
}

export class JobsRepo {
  constructor(private db: Db) {}

  insert(r: JobRow): void {
    this.db.prepare(`INSERT INTO jobs (id, type, server_id, node_id, status, progress, message, log, payload, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.type, r.server_id, r.node_id, r.status, r.progress, r.message, r.log, r.payload, r.created_at, r.updated_at, r.started_at, r.finished_at);
  }

  /** Guarda los campos que cambian con el avance. */
  save(r: JobRow): void {
    this.db.prepare(`UPDATE jobs SET status = ?, progress = ?, message = ?, log = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(r.status, r.progress, r.message, r.log, r.started_at, r.finished_at, r.updated_at, r.id);
  }

  get(id: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
  }

  /** Los más nuevos primero; como mucho 200. */
  list(f: JobListFilter): JobRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.serverId) { where.push("server_id = ?"); args.push(f.serverId); }
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.before) { where.push("created_at < ?"); args.push(f.before); }
    args.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args) as unknown as JobRow[];
  }

  /** Marca failed los jobs abiertos cuyo tipo no esté en `exceptTypes`. Devuelve sus ids. */
  failOpen(exceptTypes: readonly string[], message: string, now: string): string[] {
    const ph = exceptTypes.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id FROM jobs WHERE status IN ('queued', 'running') AND type NOT IN (${ph})`).all(...exceptTypes) as unknown as { id: string }[];
    const stmt = this.db.prepare("UPDATE jobs SET status = 'failed', message = ?, finished_at = ?, updated_at = ? WHERE id = ?");
    for (const r of rows) stmt.run(message, now, now, r.id);
    return rows.map((r) => r.id);
  }

  /** Jobs abiertos de un nodo, de los tipos dados, creados antes de `createdBefore`. */
  openForNode(nodeId: string, types: readonly string[], createdBefore: string): JobRow[] {
    const ph = types.map(() => "?").join(", ");
    return this.db.prepare(`SELECT * FROM jobs WHERE node_id = ? AND status IN ('queued', 'running') AND type IN (${ph}) AND created_at < ?`)
      .all(nodeId, ...types, createdBefore) as unknown as JobRow[];
  }

  purgeFinishedBefore(iso: string): number {
    return Number(this.db.prepare("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?").run(iso).changes);
  }
}
