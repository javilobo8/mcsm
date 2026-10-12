import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { formatCpu, isFresh, percent, usageTone } from "@/lib/metrics";
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

const totalText = (used: number, total: number) => (total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : `${formatBytes(used)} (total desconocido)`);

/** CPU, RAM y disco de DATA_ROOT de un nodo, en vivo (spec §8: tarjetas de nodo). */
export function NodeUsage({ nodeId }: { nodeId: string }) {
  const q = useNodeLive(nodeId);
  // La frescura caduca sin eventos: se reevalúa cada 10 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const s = q.data;
  if (q.isPending) return <p className="text-xs text-muted-foreground">Cargando uso…</p>;
  if (q.isError && !s) return <p role="alert" className="text-xs text-red-400">No se pudo cargar el uso del nodo</p>;
  if (!isFresh(s, now)) return <p className="text-xs text-muted-foreground">Sin datos recientes del nodo</p>;
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label="Uso del nodo">
      <UsageBar label="CPU" pct={Math.min(100, Math.max(0, s.cpuPct))} text={formatCpu(s.cpuPct)} />
      <UsageBar label="RAM" pct={percent(s.memBytes, s.memTotalBytes)} text={totalText(s.memBytes, s.memTotalBytes)} />
      <UsageBar label="Disco" pct={percent(s.diskBytes, s.diskTotalBytes)} text={totalText(s.diskBytes, s.diskTotalBytes)} />
    </div>
  );
}
