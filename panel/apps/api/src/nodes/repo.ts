import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso, plusSeconds } from "../lib/time.js";
import { hashToken, randomToken } from "../lib/tokens.js";

export interface NodeRow {
  id: string; name: string; token_hash: string; data_root: string; status: string;
  agent_version: string | null; docker_version: string | null; host_info: string | null;
  last_seen_at: string | null; created_at: string;
}

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: string; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: Record<string, unknown> | null; lastSeenAt: string | null; createdAt: string;
}

export const toNodeDto = (r: NodeRow): NodeDto => ({
  id: r.id, name: r.name, dataRoot: r.data_root, status: r.status, agentVersion: r.agent_version, dockerVersion: r.docker_version,
  hostInfo: r.host_info ? JSON.parse(r.host_info) : null, lastSeenAt: r.last_seen_at, createdAt: r.created_at,
});

export class NodesRepo {
  constructor(private db: Db) {}

  list(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes ORDER BY created_at").all() as unknown as NodeRow[];
  }
  get(id: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined) ?? null;
  }
  findByTokenHash(hash: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE token_hash = ?").get(hash) as NodeRow | undefined) ?? null;
  }
  nameExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM nodes WHERE name = ?").get(name);
  }
  create(input: { name: string; tokenHash: string; dataRoot?: string }): NodeRow {
    const id = newId();
    this.db.prepare("INSERT INTO nodes (id, name, token_hash, data_root, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.name, input.tokenHash, input.dataRoot ?? "/srv/minecraft", nowIso());
    return this.get(id)!;
  }
  rename(id: string, name: string): void {
    this.db.prepare("UPDATE nodes SET name = ? WHERE id = ?").run(name, id);
  }
  setDataRoot(id: string, dataRoot: string): void {
    this.db.prepare("UPDATE nodes SET data_root = ? WHERE id = ?").run(dataRoot, id);
  }
  setStatus(id: string, status: "online" | "offline", extra?: { agentVersion?: string; dockerVersion?: string; hostInfo?: unknown }): void {
    this.db.prepare(`UPDATE nodes SET status = ?, last_seen_at = ?,
        agent_version = COALESCE(?, agent_version), docker_version = COALESCE(?, docker_version), host_info = COALESCE(?, host_info)
      WHERE id = ?`)
      .run(status, nowIso(), extra?.agentVersion ?? null, extra?.dockerVersion ?? null, extra?.hostInfo ? JSON.stringify(extra.hostInfo) : null, id);
  }
  touch(id: string): void {
    this.db.prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?").run(nowIso(), id);
  }
  markAllOffline(): void {
    this.db.prepare("UPDATE nodes SET status = 'offline'").run();
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  }

  createEnrollmentToken(nameHint: string, ttlSeconds: number): { token: string; expiresAt: string } {
    const token = randomToken();
    const expiresAt = plusSeconds(ttlSeconds);
    this.db.prepare("INSERT INTO enrollment_tokens (id, token_hash, name_hint, expires_at) VALUES (?, ?, ?, ?)")
      .run(newId(), hashToken(token), nameHint, expiresAt);
    return { token, expiresAt };
  }
  /** Devuelve el name_hint si el token es válido, lo marca usado; null si no. */
  consumeEnrollmentToken(token: string): string | null {
    const row = this.db.prepare("SELECT id, name_hint, expires_at, used_at FROM enrollment_tokens WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; name_hint: string; expires_at: string; used_at: string | null } | undefined;
    if (!row || row.used_at || row.expires_at <= nowIso()) return null;
    this.db.prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
    return row.name_hint;
  }
}
