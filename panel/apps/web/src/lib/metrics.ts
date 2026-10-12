import type { QueryClient } from "@tanstack/react-query";
import { MAX_CLOCK_SKEW_SECONDS, type MetricColumn, type MetricRange, type MetricSeries, type NodeLiveSample } from "@mcsm/shared";
import type { ServerMessage } from "./api";
import { mergeIntoCached, type LiveSource } from "./live";
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

/** Memoria usada y límite; el límite 0 es «desconocido» y se trata como `null` (sin línea ni leyenda). */
export const memAligned = (s: MetricSeries): Aligned => [s.t, s.memBytes, s.memLimitBytes.map((v) => (v === 0 ? null : v))];

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

/** Muestra de nodo en caché con la hora (ms, reloj del navegador) a la que se recibió. */
export interface NodeLiveEntry {
  sample: NodeLiveSample;
  receivedAt: number;
}

/**
 * Entrada de caché para la última muestra de una serie REST. Aún no hay hora de llegada propia, así
 * que se toma el `ts` de la muestra; el primer evento en vivo la sustituye por la hora de llegada.
 */
export function entryFromSeries(s: MetricSeries): NodeLiveEntry | null {
  const sample = latestNodeSample(s);
  return sample && { sample, receivedAt: sample.ts * 1000 };
}

/**
 * El agente envía cada 10 s: una muestra recibida hace más de 60 s está caducada. Se mide con la hora
 * de LLEGADA local, no con el `ts` del agente, para que un agente o un navegador desfasados no dejen la
 * tarjeta caducada. El futuro tolera `MAX_CLOCK_SKEW_SECONDS` (la misma que el panel) por la entrada REST.
 */
export const isFresh = (e: NodeLiveEntry | null | undefined, nowMs: number): e is NodeLiveEntry =>
  !!e && nowMs - e.receivedAt <= 60_000 && nowMs - e.receivedAt >= -MAX_CLOCK_SKEW_SECONDS * 1000;

/** Porcentaje acotado a 0–100; `null` con total 0 ("sin límite conocido"): la UI no debe pintar %. */
export const percent = (used: number, total: number): number | null => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : null);

/** Acota a 0–100 (no finito → 0). */
export const clampPct = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/** "usado / total", o solo lo usado si el total es desconocido (0). */
export const totalText = (used: number, total: number): string =>
  total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : `${formatBytes(used)} (total desconocido)`;

export const usageTone = (pct: number | null): "ok" | "warn" | "bad" => (pct === null ? "ok" : pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok");

export const formatCpu = (v: number): string => `${Math.round(v)} %`;
export const formatCount = (v: number): string => String(Math.round(v));
export const formatTps = (v: number): string => v.toFixed(1);
export const formatMem = (v: number): string => formatBytes(v);

type NodeMetricsMsg = Extract<ServerMessage, { type: "node_metrics" }>;

/**
 * Guarda la última muestra en vivo de un nodo con su hora de llegada. Siempre sustituye a la anterior
 * (el WS es ordenado; una corrección del reloj del agente hacia atrás no debe congelar la tarjeta).
 * Con datos en caché fusiona con `mergeIntoCached`. Sin datos: si la carga REST está en marcha no hace
 * nada (traerá la muestra); si ya falló, siembra la caché para que la tarjeta se recupere.
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

/** Conecta `node_metrics` del WS con la caché. Devuelve la función de limpieza. */
export function bindNodeMetrics(qc: QueryClient, live: LiveSource): () => void {
  const offs = [
    live.subscribe("nodes", (m) => { if (m.type === "node_metrics") applyNodeMetricsEvent(qc, m); }),
    // Durante la desconexión se pierden muestras: se recarga la última por REST.
    live.onReconnect(() => { void qc.invalidateQueries({ queryKey: ["node-live"] }); }),
  ];
  return () => offs.forEach((off) => off());
}
