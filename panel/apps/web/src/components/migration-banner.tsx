import { ProgressBar } from "@/components/job-progress";
import { useJobs, useJobsLive } from "@/hooks/use-jobs";
import { useMigrationSync } from "@/hooks/use-migration";
import { activeMigrationJob } from "@/lib/migration";

/**
 * Aviso en la cabecera del servidor mientras se migra. Siempre montado: al terminar la migración refresca el servidor
 * (puede haber cambiado de nodo) con useMigrationSync.
 */
export function MigrationBanner({ serverId }: { serverId: string }) {
  useJobsLive();
  const jobs = useJobs({ serverId });
  useMigrationSync(serverId, jobs.data);
  const active = activeMigrationJob(jobs.data);
  if (!active) return null;
  return (
    <div role="status" className="rounded-md border border-sky-900 bg-sky-950/40 p-3 text-sm">
      <div className="mb-2 flex justify-between gap-2"><span>{`Migración en curso · ${active.message || "…"}`}</span><span className="tabular-nums text-zinc-400">{`${active.progress}%`}</span></div>
      <ProgressBar value={active.progress} />
      <p className="mt-2 text-xs text-zinc-400">Mientras dura, el servidor solo se puede consultar: las demás acciones esperan a que termine.</p>
    </div>
  );
}
