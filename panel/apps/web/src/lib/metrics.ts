import type { QueryClient } from "@tanstack/react-query";
import { MAX_CLOCK_SKEW_SECONDS, type MetricColumn, type MetricRange, type MetricSeries, type NodeLiveSample } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { mergeIntoCached, type LiveSource } from "./live";
import { formatBytes } from "./format";

export const RANGE_OPTIONS: { value: MetricRange; label: string }[] = [
  { value: "1h", label: "1 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 days" },
];

/** How often a chart reloads: a new 10 s, 1 min or 5 min bucket. */
export const REFRESH_MS: Record<MetricRange, number> = { "1h": 10_000, "24h": 60_000, "7d": 300_000 };

/** Data for uPlot: [t, series1, series2…] with `null` in the gaps. */
export type Aligned = [number[], ...(number | null)[][]];

export const aligned = (s: MetricSeries, cols: MetricColumn[]): Aligned => [s.t, ...cols.map((c) => s[c])];

/** Memory used and limit; limit 0 means “unknown” and is treated as `null` (no line or legend). */
export const memAligned = (s: MetricSeries): Aligned => [s.t, s.memBytes, s.memLimitBytes.map((v) => (v === 0 ? null : v))];

export const hasData = (col: (number | null)[]): boolean => col.some((v) => v !== null);

/** Latest sample of a node series (draws the card before the first live event). */
export function latestNodeSample(s: MetricSeries): NodeLiveSample | null {
  for (let i = s.t.length - 1; i >= 0; i--) {
    const cpu = s.cpuPct[i];
    if (cpu === null || cpu === undefined) continue;
    return {
      ts: s.t[i]!, cpuPct: cpu, memBytes: s.memBytes[i] ?? 0, memTotalBytes: s.memLimitBytes[i] ?? 0,
      diskBytes: s.diskBytes[i] ?? 0, diskTotalBytes: s.diskTotalBytes[i] ?? 0,
    };
  }
  return null;
}

/** Node sample in cache with the time (ms, browser clock) at which it was received. */
export interface NodeLiveEntry {
  sample: NodeLiveSample;
  receivedAt: number;
}

/**
 * Cache entry for the latest sample of a REST series. Its age is measured by the panel (`s.now − ts`, its clock)
 * and subtracted from the response's arrival time in the browser (its own): neither a skewed agent nor a skewed browser
 * leaves the card “without data” until the first live event. Without `s.now` (older panel), the sample's `ts`.
 */
export function entryFromSeries(s: MetricSeries, fetchedAtMs: number): NodeLiveEntry | null {
  const sample = latestNodeSample(s);
  if (!sample) return null;
  const receivedAt = s.now !== undefined ? fetchedAtMs - Math.max(0, s.now - sample.ts) * 1000 : sample.ts * 1000;
  return { sample, receivedAt };
}

/**
 * The agent sends every 10 s: a sample received more than 60 s ago has expired. It is measured with the local
 * ARRIVAL time, not the agent's `ts`, so that a skewed agent or browser does not leave the
 * card expired. The future tolerates `MAX_CLOCK_SKEW_SECONDS` (the same as the panel) because of the REST entry.
 */
export const isFresh = (e: NodeLiveEntry | null | undefined, nowMs: number): e is NodeLiveEntry =>
  !!e && nowMs - e.receivedAt <= 60_000 && nowMs - e.receivedAt >= -MAX_CLOCK_SKEW_SECONDS * 1000;

/** Percentage clamped to 0–100; `null` with total 0 ("no known limit"): the UI must not draw %. */
export const percent = (used: number, total: number): number | null => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : null);

/** Clamps to 0–100 (non-finite → 0). */
export const clampPct = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/** "used / total", or just the used value if the total is unknown (0). */
export const totalText = (used: number, total: number): string =>
  total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : `${formatBytes(used)} (total unknown)`;

export const usageTone = (pct: number | null): "ok" | "warn" | "bad" => (pct === null ? "ok" : pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok");

export const formatCpu = (v: number): string => `${Math.round(v)} %`;
export const formatCount = (v: number): string => String(Math.round(v));
export const formatTps = (v: number): string => v.toFixed(1);
export const formatMem = (v: number): string => formatBytes(v);

type NodeMetricsMsg = Extract<ServerMessage, { type: "node_metrics" }>;

/**
 * Stores the latest live sample of a node with its arrival time. It always replaces the previous one
 * (the WS is ordered; a backwards correction of the agent's clock must not freeze the card).
 * With cached data it merges with `mergeIntoCached`. Without data: if the REST load is running it does
 * nothing (it will bring the sample); if it already failed, it seeds the cache so the card recovers.
 */
export function applyNodeMetricsEvent(qc: QueryClient, msg: NodeMetricsMsg, now: () => number = Date.now): void {
  const key = ["node-live", msg.nodeId] as const;
  const entry = (): NodeLiveEntry => ({ sample: msg.sample, receivedAt: now() });
  if (qc.getQueryData(key) === undefined) {
    if (qc.getQueryState(key)?.status === "error" && qc.isFetching({ queryKey: key, exact: true }) === 0) qc.setQueryData<NodeLiveEntry | null>(key, entry());
    return;
  }
  mergeIntoCached<NodeLiveEntry | null>(qc, key, entry);
}

/** Connects the WS `node_metrics` to the cache. Returns the cleanup function. */
export function bindNodeMetrics(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("nodes", (m) => { if (m.type === "node_metrics") applyNodeMetricsEvent(qc, m); }),
    // Samples are lost during the disconnection: the latest one is reloaded over REST.
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: ["node-live"] }); }),
  ];
  return () => offs.forEach((off) => off());
}
