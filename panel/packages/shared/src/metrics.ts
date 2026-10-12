import { z } from "zod";

/** Rangos de las gráficas y tamaño del cubo con que se agregan al vuelo (spec §4 `metric_samples`). */
export const METRIC_RANGES = {
  "1h": { seconds: 3_600, step: 10 },
  "24h": { seconds: 86_400, step: 60 },
  "7d": { seconds: 604_800, step: 300 },
} as const;

export type MetricRange = keyof typeof METRIC_RANGES;

export const metricRangeSchema = z.enum(["1h", "24h", "7d"], { message: "Rango inválido: usa 1h, 24h o 7d" });

/** Cubos de una consulta: `count` cubos de `step` segundos; el último contiene `nowSec`. */
export function metricBuckets(range: MetricRange, nowSec: number): { from: number; step: number; count: number } {
  const { seconds, step } = METRIC_RANGES[range];
  const count = seconds / step;
  const last = Math.floor(nowSec / step) * step;
  return { from: last - (count - 1) * step, step, count };
}

/** Columnas de una serie, alineadas con `t`. */
export const METRIC_COLUMNS = [
  "cpuPct", "memBytes", "memLimitBytes", "netRxBytes", "netTxBytes", "diskBytes", "diskTotalBytes",
  "playersOnline", "playersMax", "tps", "pingMs",
] as const;

export type MetricColumn = (typeof METRIC_COLUMNS)[number];

/**
 * Serie agregada para una gráfica: `t` son los inicios de cubo (epoch s) y cada columna tiene
 * un valor por cubo, `null` si no hubo muestras (servidor parado, nodo caído).
 * Servidores: cpuPct con 100 = un núcleo; players*, tps y pingMs solo si el ping respondió.
 * `memLimitBytes = 0` en un servidor significa "sin límite de memoria conocido" (no un límite de 0 bytes).
 * Nodos: cpuPct 0–100 del host, memLimitBytes = RAM total, diskBytes/diskTotalBytes de DATA_ROOT.
 */
export type MetricSeries = { range: MetricRange; step: number; t: number[] } & Record<MetricColumn, (number | null)[]>;

/** Última muestra de un nodo; la emite el WS del navegador como `{ type: "node_metrics", nodeId, sample }`. */
export interface NodeLiveSample {
  ts: number;
  cpuPct: number;
  memBytes: number;
  memTotalBytes: number;
  diskBytes: number;
  diskTotalBytes: number;
}
