import { z } from "zod";

/** Chart ranges and the size of the bucket they are aggregated into on the fly (spec §4 `metric_samples`). */
export const METRIC_RANGES = {
  "1h": { seconds: 3_600, step: 10 },
  "24h": { seconds: 86_400, step: 60 },
  "7d": { seconds: 604_800, step: 300 },
} as const;

export type MetricRange = keyof typeof METRIC_RANGES;

export const metricRangeSchema = z.enum(["1h", "24h", "7d"], { message: "Invalid range: use 1h, 24h or 7d" });

/** Buckets of a query: `count` buckets of `step` seconds; the last one contains `nowSec`. */
export function metricBuckets(range: MetricRange, nowSec: number): { from: number; step: number; count: number } {
  const { seconds, step } = METRIC_RANGES[range];
  const count = seconds / step;
  const last = Math.floor(nowSec / step) * step;
  return { from: last - (count - 1) * step, step, count };
}

/** Columns of a series, aligned with `t`. */
export const METRIC_COLUMNS = [
  "cpuPct", "memBytes", "memLimitBytes", "netRxBytes", "netTxBytes", "diskBytes", "diskTotalBytes",
  "playersOnline", "playersMax", "tps", "pingMs",
] as const;

export type MetricColumn = (typeof METRIC_COLUMNS)[number];

/**
 * Aggregated series for a chart: `t` are the bucket starts (epoch s) and each column has
 * one value per bucket, `null` if there were no samples (server stopped, node down).
 * Servers: cpuPct with 100 = one core; players*, tps and pingMs only if the ping responded.
 * `memLimitBytes = 0` on a server means "no known memory limit" (not a 0-byte limit).
 * Nodes: cpuPct 0–100 of the host, memLimitBytes = total RAM, diskBytes/diskTotalBytes of DATA_ROOT.
 */
export type MetricSeries = { range: MetricRange; step: number; t: number[]; /** Panel time (epoch s) when computed. */ now?: number } & Record<MetricColumn, (number | null)[]>;

/**
 * Tolerated clock skew, in seconds: the panel accepts the `ts` of an agent that differs up to this much
 * from its time, and the web accepts samples with `ts` up to this much in the future. A single tolerance on both sides.
 */
export const MAX_CLOCK_SKEW_SECONDS = 45;

/** Latest sample of a node; emitted by the browser WS as `{ type: "node_metrics", nodeId, sample }`. */
export interface NodeLiveSample {
  ts: number;
  cpuPct: number;
  memBytes: number;
  memTotalBytes: number;
  diskBytes: number;
  diskTotalBytes: number;
}
