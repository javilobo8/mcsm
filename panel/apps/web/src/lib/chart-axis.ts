import type { Aligned } from "./metrics";

export type AxisKind = "count" | "percent" | "value";

/**
 * Etiquetas del eje Y. `count`: solo enteros (los ticks fraccionarios van a `null`, sin etiqueta repetida).
 * `percent`: un decimal cuando el paso entre ticks es < 1 (si no, 1 % y 2 % aparecerían repetidos).
 */
export function axisValues(splits: number[], kind: AxisKind, format: (v: number) => string): (string | null)[] {
  if (kind === "count") return splits.map((v) => (Number.isInteger(v) ? format(v) : null));
  if (kind === "percent") {
    const step = splits.length > 1 ? Math.abs(splits[1]! - splits[0]!) : 1;
    if (step < 1) return splits.map((v) => `${v.toFixed(1)} %`);
  }
  return splits.map((v) => format(v));
}

/** Resumen textual de una gráfica para lectores de pantalla: último valor y mín/máx de cada serie. */
export function summarize(data: Aligned, labels: string[], format: (v: number) => string): string {
  return labels.map((label, i) => {
    const vals = (data[i + 1] ?? []).filter((v): v is number => v !== null);
    if (vals.length === 0) return `${label}: sin datos`;
    return `${label}: último ${format(vals[vals.length - 1]!)}, mínimo ${format(Math.min(...vals))}, máximo ${format(Math.max(...vals))}`;
  }).join(". ");
}
