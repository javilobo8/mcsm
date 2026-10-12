import { useEffect, useId, useRef } from "react";
import type uPlot from "uplot";
import type { Aligned } from "@/lib/metrics";
import { axisValues, summarize, type AxisKind } from "@/lib/chart-axis";

export interface ChartLine { label: string; color: string; dash?: number[]; fill?: boolean }

interface Props {
  title: string;
  data: Aligned;
  /** Debe ser estable (constante de módulo): si cambia, la gráfica se recrea. */
  lines: ChartLine[];
  /** Debe ser estable: formatea el eje Y y la leyenda. */
  format: (v: number) => string;
  /** Rango fijo del eje Y (estable); por defecto de 0 al máximo de los datos. */
  yRange?: [number, number];
  /** Tipo de eje Y (por defecto `value`): decide las etiquetas con rangos pequeños. */
  axis?: AxisKind;
  height?: number;
}

const MIN_WIDTH = 200;

/** Lee un token del tema ya resuelto (el canvas no entiende `var()`). */
/** Color con alpha 15 % sea cual sea el formato de entrada (el navegador lo resuelve vía canvas). */
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
 * Gráfica temporal con uPlot, cargado con import dinámico (no engorda el bundle principal).
 * Los huecos (null) se dibujan como cortes. El eje X usa la zona horaria local del navegador
 * (uPlot sin `tzDate` = hora local). Se destruye al desmontar y al recrearse.
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
      const ink = token(el, "--muted-foreground", "#a1a1aa");
      const rule = token(el, "--border", "#27272a");
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
    <figure className="min-w-0">
      <figcaption className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{title}</figcaption>
      <div ref={box} className="w-full" role="img" aria-label={`Gráfica de ${title}`} aria-describedby={descId} />
      <p id={descId} className="sr-only">{summarize(data, lines.map((l) => l.label), format)}</p>
    </figure>
  );
}
