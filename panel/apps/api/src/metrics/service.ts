import type { EventEmitter } from "node:events";
import type { MetricBatch } from "@mcsm/proto";
import { MAX_CLOCK_SKEW_SECONDS, type MetricRange, type MetricSeries, type NodeLiveSample } from "@mcsm/shared";
import type { MetricRow, MetricScope, MetricsRepo } from "./repo.js";

/** History retention: 7 days (spec §4). */
export const RETENTION_SECONDS = 7 * 86_400;
/** How often whatever exceeds the retention is purged. */
export const PURGE_EVERY_MS = 3_600_000;

type Cancel = () => void;

export interface MetricsDeps {
  repo: MetricsRepo;
  /** Ids of the node's servers: samples from foreign or deleted servers are discarded. */
  serverIdsOf: (nodeId: string) => Set<string>;
  /** Receives `node_metrics` (nodeId, NodeLiveSample) on every batch with host data. */
  events: EventEmitter;
  /** Clock in ms (injectable in tests). */
  now?: () => number;
  /** Repeats `fn` every `ms` and returns the function that cancels it (injectable in tests). */
  every?: (fn: () => void, ms: number) => Cancel;
  log?: { warn(obj: object, msg: string): void };
}

const defaultEvery = (fn: () => void, ms: number): Cancel => {
  const t = setInterval(fn, ms);
  t.unref();
  return () => clearInterval(t);
};

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Batch ingestion, hourly purge and aggregation at query time (spec §7 `MetricsService`). */
export class MetricsService {
  private stopPurge: Cancel | null = null;
  private now: () => number;

  constructor(private deps: MetricsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private offsets = new Map<string, number>(); // fixed skew (s) of each node whose clock is out of tolerance

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  /**
   * 10 s window of the batch. With a reasonable agent clock (±MAX_CLOCK_SKEW_SECONDS), its own. Otherwise, the
   * agent's plus a FIXED per-node skew, computed with the first skewed batch so that it falls in the panel's current
   * window: this way the variable arrival delay neither puts two batches in the same window nor leaves gaps (m-3 of
   * Plan 2). If the node corrects its clock or the skew stops fitting (±45 s), it is recomputed.
   */
  slotOf(nodeId: string, agentTs: number): number {
    const now = this.nowSec();
    if (!Number.isFinite(agentTs)) return now - (now % 10);
    if (Math.abs(agentTs - now) <= MAX_CLOCK_SKEW_SECONDS) {
      this.offsets.delete(nodeId);
      return agentTs - (agentTs % 10);
    }
    let offset = this.offsets.get(nodeId);
    if (offset === undefined || Math.abs(agentTs + offset - now) > MAX_CLOCK_SKEW_SECONDS) {
      offset = now - (now % 10) - agentTs;
      this.offsets.set(nodeId, offset);
    }
    const ts = agentTs + offset;
    return ts - (ts % 10);
  }

  /** Forgets what is kept in memory for a deleted node (its clock skew). */
  forgetNode(nodeId: string): void {
    this.offsets.delete(nodeId);
  }

  /** Stores an agent MetricBatch. Returns how many rows it wrote. */
  ingest(nodeId: string, batch: MetricBatch): number {
    const ts = this.slotOf(nodeId, Number(batch.tsUnix));
    const rows: MetricRow[] = [];
    const h = batch.host;
    if (h) {
      rows.push({
        scope: "node", scopeId: nodeId, ts, cpuPct: finite(h.cpuPct),
        memBytes: Number(h.memUsedBytes), memLimitBytes: Number(h.memTotalBytes), netRxBytes: null, netTxBytes: null,
        diskBytes: Number(h.diskUsedBytes), diskTotalBytes: Number(h.diskTotalBytes),
        playersOnline: null, playersMax: null, tps: null, pingMs: null,
      });
    }
    if (batch.servers.length > 0) {
      const mine = this.deps.serverIdsOf(nodeId);
      for (const s of batch.servers) {
        if (!mine.has(s.serverId)) continue;
        const online = s.mcOnline;
        rows.push({
          scope: "server", scopeId: s.serverId, ts, cpuPct: finite(s.cpuPct),
          memBytes: Number(s.memBytes), memLimitBytes: Number(s.memLimitBytes),
          netRxBytes: Number(s.netRxBytes), netTxBytes: Number(s.netTxBytes), diskBytes: null, diskTotalBytes: null,
          playersOnline: online ? s.playersOnline : null, playersMax: online ? s.playersMax : null,
          pingMs: online ? s.pingMs : null,
          tps: online && s.tps !== undefined && Number.isFinite(s.tps) ? s.tps : null,
        });
      }
    }
    this.deps.repo.insertMany(rows);
    if (h) {
      const sample: NodeLiveSample = {
        ts, cpuPct: finite(h.cpuPct), memBytes: Number(h.memUsedBytes), memTotalBytes: Number(h.memTotalBytes),
        diskBytes: Number(h.diskUsedBytes), diskTotalBytes: Number(h.diskTotalBytes),
      };
      try {
        this.deps.events.emit("node_metrics", nodeId, sample);
      } catch (e) {
        // A listener that throws must not break ingestion: the rows are already stored.
        this.deps.log?.warn({ err: e }, "failure in a node_metrics listener");
      }
    }
    return rows.length;
  }

  /** Deletes whatever exceeds the retention. Returns how many rows it deleted. */
  purge(): number {
    return this.deps.repo.deleteOlderThan(this.nowSec() - RETENTION_SECONDS);
  }

  /** Purges now and then every hour. */
  start(): void {
    if (this.stopPurge) return;
    this.safePurge();
    this.stopPurge = (this.deps.every ?? defaultEvery)(() => this.safePurge(), PURGE_EVERY_MS);
  }

  stop(): void {
    this.stopPurge?.();
    this.stopPurge = null;
  }

  series(scope: MetricScope, scopeId: string, range: MetricRange): MetricSeries {
    return { ...this.deps.repo.series(scope, scopeId, range, this.nowSec()), now: this.nowSec() };
  }

  private safePurge() {
    try {
      this.purge();
    } catch (e) {
      this.deps.log?.warn({ err: e }, "failed purging old metrics");
    }
  }
}
