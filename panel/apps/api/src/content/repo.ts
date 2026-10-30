import type { ContentPlatform } from "@mcsm/shared";
import type { Db } from "../db/db.js";

/** What the metadata cache holds: project meta, versions, pack contents and slug → id references. */
export type MetaKind = "project" | "version" | "pack" | "ref";

export interface MetaRow { data: unknown; fetchedAt: string }

/** Ids per `IN (…)` statement (SQLite's default limit on variables is far above it). */
const CHUNK = 500;

/**
 * Durable cache of content metadata (`content_meta`): lets the installed list resolve names, icons and versions
 * when the sources are down, and avoids asking twice for what does not change (a version, a pack's contents).
 */
export class ContentMetaRepo {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  get(platform: ContentPlatform, kind: MetaKind, id: string): MetaRow | null {
    const row = this.db.prepare("SELECT data, fetched_at FROM content_meta WHERE platform = ? AND kind = ? AND id = ?")
      .get(platform, kind, id) as { data: string; fetched_at: string } | undefined;
    return row ? { data: JSON.parse(row.data) as unknown, fetchedAt: row.fetched_at } : null;
  }

  /** Only the ids that are stored. */
  getMany(platform: ContentPlatform, kind: MetaKind, ids: string[]): Map<string, MetaRow> {
    const out = new Map<string, MetaRow>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const part = unique.slice(i, i + CHUNK);
      const rows = this.db.prepare(
        `SELECT id, data, fetched_at FROM content_meta WHERE platform = ? AND kind = ? AND id IN (${part.map(() => "?").join(", ")})`,
      ).all(platform, kind, ...part) as { id: string; data: string; fetched_at: string }[];
      for (const r of rows) out.set(r.id, { data: JSON.parse(r.data) as unknown, fetchedAt: r.fetched_at });
    }
    return out;
  }

  put(platform: ContentPlatform, kind: MetaKind, id: string, data: unknown): void {
    this.db.prepare(`INSERT INTO content_meta (platform, kind, id, data, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(platform, kind, id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
      .run(platform, kind, id, JSON.stringify(data), new Date(this.now()).toISOString());
  }

  /** Deletes rows fetched before `iso`; returns how many. */
  purgeOlderThan(iso: string): number {
    return Number(this.db.prepare("DELETE FROM content_meta WHERE fetched_at < ?").run(iso).changes);
  }
}
