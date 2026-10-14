import { useMemo, useState } from "react";
import type { MetricRange } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { TimeSeriesChart, type ChartLine } from "@/components/time-series-chart";
import { CHART_COLORS as C } from "@/components/chart-colors";
import { SectionTitle } from "@/components/page-header";
import { useServerMetrics } from "@/hooks/use-metrics";
import { RANGE_OPTIONS, aligned, memAligned, formatCount, formatCpu, formatMem, formatTps, hasData } from "@/lib/metrics";

const PLAYERS: ChartLine[] = [{ label: "Connected", color: C.players, fill: true }, { label: "Max", color: C.guide, dash: [4, 4] }];
const CPU: ChartLine[] = [{ label: "CPU", color: C.cpu, fill: true }];
// With no known limit the “Limit” series is all null: only the absolute value is shown, never a %.
const MEM: ChartLine[] = [{ label: "Used", color: C.memory, fill: true }, { label: "Limit", color: C.guide, dash: [4, 4] }];
const TPS: ChartLine[] = [{ label: "TPS", color: C.tps }];
const TPS_RANGE: [number, number] = [0, 21];

/** 1 h / 24 h / 7 day charts of a server's Overview (spec §8). */
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
    <section aria-label="History" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionTitle>History</SectionTitle>
        <div role="group" aria-label="Chart range" className="ml-auto flex gap-1">
          {RANGE_OPTIONS.map((o) => (
            <Button key={o.value} size="sm" variant={o.value === range ? "secondary" : "ghost"} aria-pressed={o.value === range} onClick={() => setRange(o.value)}>{o.label}</Button>
          ))}
        </div>
      </div>
      {q.isPending && <p className="text-sm text-muted-foreground">Loading metrics…</p>}
      {q.isError && <p role="alert" className="text-sm text-bad">Could not load the metrics: {q.error.message}</p>}
      {s && data && !hasData(s.cpuPct) && (
        <p className="text-sm text-muted-foreground">No data in this range: metrics are collected every 10 s while the server is running.</p>
      )}
      {s && data && hasData(s.cpuPct) && (
        // key=range: changing the range destroys and recreates the charts.
        <div key={range} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TimeSeriesChart title="Players" data={data.players} lines={PLAYERS} format={formatCount} axis="count" />
          <TimeSeriesChart title="CPU (100 % = 1 core)" data={data.cpu} lines={CPU} format={formatCpu} axis="percent" />
          <TimeSeriesChart title="Memory" data={data.mem} lines={MEM} format={formatMem} />
          {hasData(s.tps) && <TimeSeriesChart title="TPS" data={data.tps} lines={TPS} format={formatTps} yRange={TPS_RANGE} />}
        </div>
      )}
    </section>
  );
}
