import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso, plusSeconds } from "../lib/time.js";
import { hashToken, randomToken } from "../lib/tokens.js";

export interface NodeRow {
  id: string; name: string; token_hash: string; data_root: string; status: string;
  agent_version: string | null; docker_version: string | null; host_info: string | null;
  last_seen_at: string | null; created_at: string;
  pending_token_hash: string | null; pending_token_at: string | null;
}

export interface NodeDto {
  id: string; name: string; dataRoot: string; status: string; agentVersion: string | null; dockerVersion: string | null;
  hostInfo: Record<string, unknown> | null; lastSeenAt: string | null; createdAt: string;
  tokenRotationPending: boolean;
}

export const toNodeDto = (r: NodeRow): NodeDto => ({
  id: r.id, name: r.name, dataRoot: r.data_root, status: r.status, agentVersion: r.agent_version, dockerVersion: r.docker_version,
  hostInfo: r.host_info ? JSON.parse(r.host_info) : null, lastSeenAt: r.last_seen_at, createdAt: r.created_at,
  tokenRotationPending: !!r.pending_token_hash,
});

/** SQLite foreign key error (e.g. deleting a node that has servers). */
export const isForeignKeyError = (e: unknown): boolean =>
  e instanceof Error && /FOREIGN KEY constraint failed/.test(e.message);

export class NodesRepo {
  constructor(private db: Db) {}

  list(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes ORDER BY created_at").all() as unknown as NodeRow[];
  }
  get(id: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined) ?? null;
  }
  /** Node by the hash of its current token or of the pending one of a rotation (spec §9). */
  findByTokenHash(hash: string): NodeRow | null {
    return (this.db.prepare("SELECT * FROM nodes WHERE token_hash = ? OR pending_token_hash = ?").get(hash, hash) as NodeRow | undefined) ?? null;
  }
  /** Stores (or deletes, with null) the hash of the new token of a rotation in progress. */
  setPendingToken(id: string, hash: string | null): void {
    this.db.prepare("UPDATE nodes SET pending_token_hash = ?, pending_token_at = ? WHERE id = ?").run(hash, hash ? nowIso() : null, id);
  }
  /** The agent connected with the pending token: it becomes the node's token and the previous one stops being valid. */
  promotePendingToken(id: string): boolean {
    return Number(this.db.prepare(
      "UPDATE nodes SET token_hash = pending_token_hash, pending_token_hash = NULL, pending_token_at = NULL WHERE id = ? AND pending_token_hash IS NOT NULL",
    ).run(id).changes) === 1;
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

  createEnrollmentToken(nameHint: string, ttlSeconds: number, dataRoot: string): { token: string; expiresAt: string } {
    const token = randomToken();
    const expiresAt = plusSeconds(ttlSeconds);
    this.db.prepare("INSERT INTO enrollment_tokens (id, token_hash, name_hint, data_root, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId(), hashToken(token), nameHint, dataRoot, expiresAt);
    return { token, expiresAt };
  }

  /**
   * Redeems an enrollment token and creates the node in a single transaction: atomic consumption
   * (conditional UPDATE with RETURNING) and, if creation fails, the token is not burned.
   * Returns null if the token is unknown, expired or already used.
   */
  enrollNode(enrollToken: string, agentVersion?: string): { nodeId: string; nodeToken: string } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = nowIso();
      const row = this.db.prepare(
        "UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING name_hint, data_root",
      ).get(now, hashToken(enrollToken), now) as { name_hint: string; data_root: string } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      let name = row.name_hint;
      for (let i = 2; this.nameExists(name); i++) name = `${row.name_hint}-${i}`;
      const nodeToken = randomToken();
      const node = this.create({ name, tokenHash: hashToken(nodeToken), dataRoot: row.data_root });
      if (agentVersion) this.setStatus(node.id, "offline", { agentVersion });
      this.db.exec("COMMIT");
      return { nodeId: node.id, nodeToken };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
