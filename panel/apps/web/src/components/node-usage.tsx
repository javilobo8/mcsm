import { useEffect, useReducer } from "react";
import { cn } from "@/lib/utils";
import { clampPct, formatCpu, isFresh, percent, totalText, usageTone } from "@/lib/metrics";
import { useNodeLive } from "@/hooks/use-metrics";
import { TONE_FILL as TONE } from "@/components/status";

/** With an unknown total (`pct` null) no bar or % is drawn: only the used value. */
function UsageBar({ label, pct, text }: { label: string; pct: number | null; text: string }) {
  return (
    <div className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {pct === null ? (
        <span className="text-muted-foreground" aria-hidden>—</span>
      ) : (
        <div
          role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
          aria-valuetext={`${Math.round(pct)} % · ${text}`}
          className="h-2 overflow-hidden bg-obsidian shadow-[inset_0_0_0_1px_var(--cobble)]"
        >
          <div className={cn("h-full transition-[width]", TONE[usageTone(pct)])} style={{ width: `${pct}%` }} />
        </div>
      )}
      <span className="tabular-nums text-foreground/80">{text}</span>
    </div>
  );
}

/** Forces a re-render every `ms` (freshness expires without events); the clock is read with `Date.now()` on each render. */
function useTick(ms: number): void {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** CPU, RAM and DATA_ROOT disk of a node, live (spec §8: node cards). */
export function NodeUsage({ nodeId }: { nodeId: string }) {
  const q = useNodeLive(nodeId);
  useTick(10_000);
  const e = q.data;
  if (q.isPending) return <p className="text-xs text-muted-foreground">Loading usage…</p>;
  if (q.isError && !e && q.dataUpdatedAt === 0) return <p role="alert" className="text-xs text-bad">Could not load the node's usage</p>;
  if (!isFresh(e, Date.now())) return <p className="text-xs text-muted-foreground">No recent data from the node</p>;
  const s = e.sample;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Node usage">
      <UsageBar label="CPU" pct={clampPct(s.cpuPct)} text={formatCpu(s.cpuPct)} />
      <UsageBar label="RAM" pct={percent(s.memBytes, s.memTotalBytes)} text={totalText(s.memBytes, s.memTotalBytes)} />
      <UsageBar label="Disk" pct={percent(s.diskBytes, s.diskTotalBytes)} text={totalText(s.diskBytes, s.diskTotalBytes)} />
    </div>
  );
}
