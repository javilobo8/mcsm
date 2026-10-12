import { useEffect, useReducer } from "react";
import { cn } from "@/lib/utils";
import { clampPct, formatCpu, isFresh, percent, totalText, usageTone } from "@/lib/metrics";
import { useNodeLive } from "@/hooks/use-metrics";

const TONE = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" } as const;

/** Con total desconocido (`pct` null) no se pinta barra ni %: solo el valor usado. */
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
          className="h-1.5 overflow-hidden rounded bg-muted"
        >
          <div className={cn("h-full transition-[width]", TONE[usageTone(pct)])} style={{ width: `${pct}%` }} />
        </div>
      )}
      <span className="tabular-nums text-foreground/80">{text}</span>
    </div>
  );
}

/** Fuerza un re-render cada `ms` (la frescura caduca sin eventos); el reloj se lee con `Date.now()` en cada render. */
function useTick(ms: number): void {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** CPU, RAM y disco de DATA_ROOT de un nodo, en vivo (spec §8: tarjetas de nodo). */
export function NodeUsage({ nodeId }: { nodeId: string }) {
  const q = useNodeLive(nodeId);
  useTick(10_000);
  const e = q.data;
  if (q.isPending) return <p className="text-xs text-muted-foreground">Cargando uso…</p>;
  if (q.isError && !e && q.dataUpdatedAt === 0) return <p role="alert" className="text-xs text-red-400">No se pudo cargar el uso del nodo</p>;
  if (!isFresh(e, Date.now())) return <p className="text-xs text-muted-foreground">Sin datos recientes del nodo</p>;
  const s = e.sample;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Uso del nodo">
      <UsageBar label="CPU" pct={clampPct(s.cpuPct)} text={formatCpu(s.cpuPct)} />
      <UsageBar label="RAM" pct={percent(s.memBytes, s.memTotalBytes)} text={totalText(s.memBytes, s.memTotalBytes)} />
      <UsageBar label="Disco" pct={percent(s.diskBytes, s.diskTotalBytes)} text={totalText(s.diskBytes, s.diskTotalBytes)} />
    </div>
  );
}
