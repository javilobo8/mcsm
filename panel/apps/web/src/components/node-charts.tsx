import { useMemo, useState } from "react";
import type { MetricRange } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { TimeSeriesChart, type ChartLine } from "@/components/time-series-chart";
import { useNodeMetrics } from "@/hooks/use-metrics";
import { RANGE_OPTIONS, formatCpu, formatMem, hasData } from "@/lib/metrics";
import { nodeChartsData } from "@/lib/node-detail";

const GUIDE = "#71717a";
const CPU: ChartLine[] = [{ label: "CPU", color: "#34d399", fill: true }];
const MEM: ChartLine[] = [{ label: "Used", color: "#a78bfa", fill: true }, { label: "Total", color: GUIDE, dash: [4, 4] }];
const DISK: ChartLine[] = [{ label: "Used", color: "#f59e0b", fill: true }, { label: "Total", color: GUIDE, dash: [4, 4] }];

/** 1 h / 24 h / 7 day charts of a node's host (spec §8: Nodes → detail with metrics). */
export function NodeCharts({ nodeId }: { nodeId: string }) {
  const [range, setRange] = useState<MetricRange>("1h");
  const q = useNodeMetrics(nodeId, range);
  const s = q.data;
  const data = useMemo(() => s && nodeChartsData(s), [s]);
  return (
    <section aria-label="Node history" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
        <div role="group" aria-label="Chart range" className="ml-auto flex gap-1">
          {RANGE_OPTIONS.map((o) => (
            <Button key={o.value} size="sm" variant={o.value === range ? "secondary" : "ghost"} aria-pressed={o.value === range} onClick={() => setRange(o.value)}>{o.label}</Button>
          ))}
        </div>
      </div>
      {q.isPending && <p className="text-sm text-muted-foreground">Loading metrics…</p>}
      {q.isError && <p role="alert" className="text-sm text-red-400">Could not load the metrics: {q.error.message}</p>}
      {s && data && !hasData(s.cpuPct) && <p className="text-sm text-muted-foreground">No data in this range: the agent sends a sample every 10 s while connected.</p>}
      {s && data && hasData(s.cpuPct) && (
        <div key={range} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <TimeSeriesChart title="Host CPU" data={data.cpu} lines={CPU} format={formatCpu} axis="percent" />
          <TimeSeriesChart title="Memory" data={data.mem} lines={MEM} format={formatMem} />
          <TimeSeriesChart title="DATA_ROOT disk" data={data.disk} lines={DISK} format={formatMem} />
        </div>
      )}
    </section>
  );
}
