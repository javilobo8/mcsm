import type { QueryClient } from "@tanstack/react-query";
import type { MetricColumn, MetricRange, MetricSeries, NodeLiveSample } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import type { LiveSource } from "./live";
import { formatBytes } from "./format";

export const RANGE_OPTIONS: { value: MetricRange; label: string }[] = [
  { value: "1h", label: "1 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 días" },
];

/** Cada cuánto se recarga una gráfica: un cubo nuevo de 10 s, 1 min o 5 min. */
export const REFRESH_MS: Record<MetricRange, number> = { "1h": 10_000, "24h": 60_000, "7d": 300_000 };

/** Datos para uPlot: [t, serie1, serie2…] con `null` en los huecos. */
export type Aligned = [number[], ...(number | null)[][]];

export const aligned = (s: MetricSeries, cols: MetricColumn[]): Aligned => [s.t, ...cols.map((c) => s[c])];

export const hasData = (col: (number | null)[]): boolean => col.some((v) => v !== null);

/** Última muestra de una serie de nodo (pinta la tarjeta antes del primer evento en vivo). */
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

/** El agente envía cada 10 s: una muestra con más de 60 s está caducada. */
export const isFresh = (s: NodeLiveSample | null | undefined, nowMs: number): s is NodeLiveSample =>
  !!s && nowMs / 1000 - s.ts <= 60;

/** Porcentaje acotado a 0–100; con total 0 ("sin límite conocido") devuelve 0: quien pinte debe comprobar el total antes. */
export const percent = (used: number, total: number): number => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);

export const usageTone = (pct: number): "ok" | "warn" | "bad" => (pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok");

export const formatCpu = (v: number): string => `${Math.round(v)} %`;
export const formatCount = (v: number): string => String(Math.round(v));
export const formatTps = (v: number): string => v.toFixed(1);
export const formatMem = (v: number): string => formatBytes(v);

type NodeMetricsMsg = Extract<ServerMessage, { type: "node_metrics" }>;

/** Guarda la última muestra en vivo de un nodo; una más antigua que la que hay no la pisa. */
export function applyNodeMetricsEvent(qc: QueryClient, msg: NodeMetricsMsg): void {
  qc.setQueryData<NodeLiveSample | null>(["node-live", msg.nodeId], (old) => (old && old.ts > msg.sample.ts ? old : msg.sample));
}

/** Conecta `node_metrics` del WS con la caché. Devuelve la función de limpieza. */
export function bindNodeMetrics(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("nodes", (m) => { if (m.type === "node_metrics") applyNodeMetricsEvent(qc, m); }),
    // Durante la desconexión se pierden muestras: se recarga la última por REST.
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: ["node-live"] }); }),
  ];
  return () => offs.forEach((off) => off());
}
