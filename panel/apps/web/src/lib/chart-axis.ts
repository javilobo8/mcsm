import type { Aligned } from "./metrics";

export type AxisKind = "count" | "percent" | "value";

/**
 * Y axis labels. `count`: integers only (fractional ticks become `null`, with no repeated label).
 * `percent`: one decimal when the step between ticks is < 1 (otherwise 1 % and 2 % would appear repeated).
 */
export function axisValues(splits: number[], kind: AxisKind, format: (v: number) => string): (string | null)[] {
  if (kind === "count") return splits.map((v) => (Number.isInteger(v) ? format(v) : null));
  if (kind === "percent") {
    const step = splits.length > 1 ? Math.abs(splits[1]! - splits[0]!) : 1;
    if (step < 1) return splits.map((v) => `${v.toFixed(1)} %`);
  }
  return splits.map((v) => format(v));
}

/** Text summary of a chart for screen readers: last value and min/max of each series. */
export function summarize(data: Aligned, labels: string[], format: (v: number) => string): string {
  return labels.map((label, i) => {
    const vals = (data[i + 1] ?? []).filter((v): v is number => v !== null);
    if (vals.length === 0) return `${label}: no data`;
    return `${label}: last ${format(vals[vals.length - 1]!)}, min ${format(Math.min(...vals))}, max ${format(Math.max(...vals))}`;
  }).join(". ");
}
