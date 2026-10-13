import type { StatementSync } from "node:sqlite";
import { METRIC_COLUMNS, metricBuckets, type MetricColumn, type MetricRange, type MetricSeries } from "@mcsm/shared";
import type { Db } from "../db/db.js";

export type MetricScope = "server" | "node";

/** A `metric_samples` row. `ts` in epoch seconds, a multiple of 10. */
export type MetricRow = { scope: MetricScope; scopeId: string; ts: number } & Record<MetricColumn, number | null>;

/** SQL column and per-bucket aggregation of each series column. */
const AGG: Record<MetricColumn, string> = {
  cpuPct: "AVG(cpu_pct)",
  memBytes: "AVG(mem_bytes)",
  memLimitBytes: "MAX(mem_limit_bytes)",
  netRxBytes: "MAX(net_rx_bytes)", // cumulative counters: the bucket's last one
  netTxBytes: "MAX(net_tx_bytes)",
  diskBytes: "MAX(disk_bytes)",
  diskTotalBytes: "MAX(disk_total_bytes)",
  playersOnline: "MAX(players_online)", // bucket peak: a player who joins and leaves does not disappear
  playersMax: "MAX(players_max)",
  tps: "AVG(tps)", // AVG ignores NULLs (servers without TPS or without a measurement)
  pingMs: "AVG(ping_ms)",
};

const SQL_COLUMN: Record<MetricColumn, string> = {
  cpuPct: "cpu_pct", memBytes: "mem_bytes", memLimitBytes: "mem_limit_bytes", netRxBytes: "net_rx_bytes",
  netTxBytes: "net_tx_bytes", diskBytes: "disk_bytes", diskTotalBytes: "disk_total_bytes",
  playersOnline: "players_online", playersMax: "players_max", tps: "tps", pingMs: "ping_ms",
};

/** Decimals with which each column is returned (bytes and counters, integers). */
const DECIMALS: Partial<Record<MetricColumn, number>> = { cpuPct: 1, tps: 2, pingMs: 0 };

const round = (v: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

export class MetricsRepo {
  private insert: StatementSync;
  private aggregate: StatementSync;

  constructor(private db: Db) {
    const cols = METRIC_COLUMNS.map((c) => SQL_COLUMN[c]);
    this.insert = db.prepare(
      `INSERT OR REPLACE INTO metric_samples (scope, scope_id, ts, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})`,
    );
    // node:sqlite binds JS numbers as REAL: without CAST, ts / 10 would be a real division
    // and there would be no buckets.
    this.aggregate = db.prepare(
      `SELECT (ts / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS t, ${METRIC_COLUMNS.map((c) => `${AGG[c]} AS ${c}`).join(", ")}
       FROM metric_samples
       WHERE scope = ? AND scope_id = ? AND ts >= ? AND ts < ?
       GROUP BY t ORDER BY t`,
    );
  }

  /** Inserts (or replaces, if that window already exists) all rows in one transaction. */
  insertMany(rows: MetricRow[]): void {
    if (rows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) this.insert.run(r.scope, r.scopeId, r.ts, ...METRIC_COLUMNS.map((c) => r[c]));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Deletes the rows with `ts` before `beforeTs`. Returns how many it deleted. */
  deleteOlderThan(beforeTs: number): number {
    return Number(this.db.prepare("DELETE FROM metric_samples WHERE ts < ?").run(beforeTs).changes);
  }

  count(scope: MetricScope, scopeId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM metric_samples WHERE scope = ? AND scope_id = ?").get(scope, scopeId) as { n: number }).n;
  }

  /** Aggregates on the fly into range buckets and fills buckets without samples with null. */
  series(scope: MetricScope, scopeId: string, range: MetricRange, nowSec: number): MetricSeries {
    const { from, step, count } = metricBuckets(range, nowSec);
    const out = { range, step, t: Array.from({ length: count }, (_, i) => from + i * step) } as MetricSeries;
    for (const c of METRIC_COLUMNS) out[c] = new Array<number | null>(count).fill(null);
    const rows = this.aggregate.all(step, step, scope, scopeId, from, from + count * step) as unknown as ({ t: number } & Record<MetricColumn, number | null>)[];
    for (const row of rows) {
      const i = (row.t - from) / step;
      if (!Number.isInteger(i) || i < 0 || i >= count) continue;
      for (const c of METRIC_COLUMNS) {
        const v = row[c];
        out[c][i] = v === null ? null : round(v, DECIMALS[c] ?? 0);
      }
    }
    return out;
  }
}
