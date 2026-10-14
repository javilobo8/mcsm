import { useEffect, useId, useRef } from "react";
import type uPlot from "uplot";
import type { Aligned } from "@/lib/metrics";
import { axisValues, summarize, type AxisKind } from "@/lib/chart-axis";

export interface ChartLine { label: string; color: string; dash?: number[]; fill?: boolean }

interface Props {
  title: string;
  data: Aligned;
  /** Must be stable (module constant): if it changes, the chart is recreated. */
  lines: ChartLine[];
  /** Must be stable: formats the Y axis and the legend. */
  format: (v: number) => string;
  /** Fixed Y axis range (stable); by default from 0 to the data maximum. */
  yRange?: [number, number];
  /** Y axis type (default `value`): decides the labels with small ranges. */
  axis?: AxisKind;
  height?: number;
}

const MIN_WIDTH = 200;

/** Reads a token from the resolved theme (the canvas does not understand `var()`). */
/** Colour with 15 % alpha whatever the input format (the browser resolves it through the canvas). */
function translucent(color: string): string {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, 0.15)`;
  } catch { return color; }
}

const token = (el: Element, name: string, fallback: string): string => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/**
 * Time series chart with uPlot, loaded with a dynamic import (it does not bloat the main bundle).
 * Gaps (null) are drawn as breaks. The X axis uses the browser's local time zone
 * (uPlot without `tzDate` = local time). It is destroyed on unmount and when recreated.
 */
export function TimeSeriesChart({ title, data, lines, format, yRange, axis: axisKind = "value", height = 160 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const descId = useId();
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void Promise.all([import("uplot"), import("uplot/dist/uPlot.min.css")]).then(([mod]) => {
      if (cancelled) return;
      const UPlot = mod.default;
      const ink = token(el, "--muted-foreground", "#a0a7af");
      const rule = token(el, "--border", "#282d35");
      const axis: uPlot.Axis = { stroke: ink, grid: { stroke: rule, width: 1 }, ticks: { stroke: rule, width: 1 } };
      const u = new UPlot({
        width: Math.max(el.clientWidth, MIN_WIDTH),
        height,
        cursor: { drag: { x: false, y: false, setScale: false } },
        scales: { y: { range: (_u, _min, max) => yRange ?? [0, Math.max(max, 1) * 1.1] } },
        axes: [axis, { ...axis, size: 70, values: (_u, splits) => axisValues(splits, axisKind, format) }],
        series: [
          { value: (_u, v) => (v == null ? "—" : new Date(v * 1000).toLocaleString()) },
          ...lines.map((l): uPlot.Series => ({
            label: l.label, stroke: l.color, width: 1.5, dash: l.dash, fill: l.fill ? translucent(l.color) : undefined,
            spanGaps: false,
            value: (_u, v) => (v == null ? "—" : format(v)),
          })),
        ],
      }, latest.current, el);
      plot.current = u;
      const ro = new ResizeObserver(() => u.setSize({ width: Math.max(el.clientWidth, MIN_WIDTH), height }));
      ro.observe(el);
      cleanup = () => { ro.disconnect(); u.destroy(); plot.current = null; };
    });
    return () => { cancelled = true; cleanup(); };
  }, [lines, format, yRange, axisKind, height]);

  useEffect(() => { plot.current?.setData(data); }, [data]);

  return (
    <figure className="min-w-0 rounded-lg border border-cobble bg-bedrock/70 p-3">
      <figcaption className="mb-2 text-sm font-medium text-bone">{title}</figcaption>
      <div ref={box} className="w-full" role="img" aria-label={`Chart of ${title}`} aria-describedby={descId} />
      <p id={descId} className="sr-only">{summarize(data, lines.map((l) => l.label), format)}</p>
    </figure>
  );
}
