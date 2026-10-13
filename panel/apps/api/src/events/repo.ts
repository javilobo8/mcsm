import type { EventDto, EventLevelName, EventsQuery } from "@mcsm/shared";
import type { Db } from "../db/db.js";

export interface EventRow {
  id: string; node_id: string | null; server_id: string | null; server_name: string | null; level: EventLevelName;
  kind: string; message: string; agent_at: string | null; created_at: string;
}

export const toEventDto = (r: EventRow): EventDto => ({
  id: r.id, nodeId: r.node_id, serverId: r.server_id, serverName: r.server_name, level: r.level, kind: r.kind,
  message: r.message, createdAt: r.created_at, agentAt: r.agent_at,
});

/** Niveles que incluye cada nivel mínimo. */
const AT_LEAST: Record<EventLevelName, EventLevelName[]> = { info: ["info", "warn", "error"], warn: ["warn", "error"], error: ["error"] };

export class EventsRepo {
  constructor(private db: Db) {}

  insert(r: EventRow): void {
    this.db.prepare(`INSERT INTO events (id, node_id, server_id, server_name, level, kind, message, agent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.node_id, r.server_id, r.server_name, r.level, r.kind, r.message, r.agent_at, r.created_at);
  }

  /** Más nuevos primero. */
  list(f: Partial<EventsQuery> & { limit: number }): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.serverId) { where.push("server_id = ?"); args.push(f.serverId); }
    if (f.nodeId) { where.push("node_id = ?"); args.push(f.nodeId); }
    if (f.minLevel) {
      const levels = AT_LEAST[f.minLevel];
      where.push(`level IN (${levels.map(() => "?").join(", ")})`);
      args.push(...levels);
    }
    if (f.before) { where.push("created_at < ?"); args.push(f.before); }
    args.push(f.limit);
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args) as unknown as EventRow[];
  }

  /** Borra lo anterior a `olderThan` y, de lo que quede, todo menos los `keep` más nuevos. Devuelve cuántos borró. */
  purge(olderThan: string, keep: number): number {
    const old = Number(this.db.prepare("DELETE FROM events WHERE created_at < ?").run(olderThan).changes);
    const extra = Number(this.db.prepare(
      "DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)",
    ).run(keep).changes);
    return old + extra;
  }
}
