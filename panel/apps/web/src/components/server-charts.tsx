import { useMemo, useState } from "react";
import type { MetricRange } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { TimeSeriesChart, type ChartLine } from "@/components/time-series-chart";
import { useServerMetrics } from "@/hooks/use-metrics";
import { RANGE_OPTIONS, aligned, memAligned, formatCount, formatCpu, formatMem, formatTps, hasData } from "@/lib/metrics";

const GUIDE = "#71717a";
const PLAYERS: ChartLine[] = [{ label: "Conectados", color: "#38bdf8", fill: true }, { label: "Máximo", color: GUIDE, dash: [4, 4] }];
const CPU: ChartLine[] = [{ label: "CPU", color: "#34d399", fill: true }];
// Sin límite conocido la serie «Límite» es toda null: solo se muestra el valor absoluto, nunca un %.
const MEM: ChartLine[] = [{ label: "Usada", color: "#a78bfa", fill: true }, { label: "Límite", color: GUIDE, dash: [4, 4] }];
const TPS: ChartLine[] = [{ label: "TPS", color: "#fbbf24" }];
const TPS_RANGE: [number, number] = [0, 21];

/** Gráficas 1 h / 24 h / 7 días del Resumen de un servidor (spec §8). */
export function ServerCharts({ serverId }: { serverId: string }) {
  const [range, setRange] = useState<MetricRange>("1h");
  const q = useServerMetrics(serverId, range);
  const s = q.data;
  const data = useMemo(() => s && {
    players: aligned(s, ["playersOnline", "playersMax"]),
    cpu: aligned(s, ["cpuPct"]),
    mem: memAligned(s),
    tps: aligned(s, ["tps"]),
  }, [s]);

  return (
    <section aria-label="Histórico" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Histórico</h2>
        <div role="group" aria-label="Rango de las gráficas" className="ml-auto flex gap-1">
          {RANGE_OPTIONS.map((o) => (
            <Button key={o.value} size="sm" variant={o.value === range ? "secondary" : "ghost"} aria-pressed={o.value === range} onClick={() => setRange(o.value)}>{o.label}</Button>
          ))}
        </div>
      </div>
      {q.isPending && <p className="text-sm text-muted-foreground">Cargando métricas…</p>}
      {q.isError && <p role="alert" className="text-sm text-red-400">No se pudieron cargar las métricas: {q.error.message}</p>}
      {s && data && !hasData(s.cpuPct) && (
        <p className="text-sm text-muted-foreground">Sin datos en este rango: las métricas se recogen cada 10 s mientras el servidor está en marcha.</p>
      )}
      {s && data && hasData(s.cpuPct) && (
        // key=range: al cambiar de rango se destruyen las gráficas y se recrean.
        <div key={range} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TimeSeriesChart title="Jugadores" data={data.players} lines={PLAYERS} format={formatCount} axis="count" />
          <TimeSeriesChart title="CPU (100 % = 1 núcleo)" data={data.cpu} lines={CPU} format={formatCpu} axis="percent" />
          <TimeSeriesChart title="Memoria" data={data.mem} lines={MEM} format={formatMem} />
          {hasData(s.tps) && <TimeSeriesChart title="TPS" data={data.tps} lines={TPS} format={formatTps} yRange={TPS_RANGE} />}
        </div>
      )}
    </section>
  );
}
