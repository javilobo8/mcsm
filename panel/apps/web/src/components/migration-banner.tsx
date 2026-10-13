import { ProgressBar } from "@/components/job-progress";
import { useJobs, useJobsLive } from "@/hooks/use-jobs";
import { useMigrationSync } from "@/hooks/use-migration";
import { activeMigrationJob } from "@/lib/migration";

/**
 * Notice in the server header while it is migrating. Always mounted: when the migration ends it refreshes the server
 * (it may have changed node) with useMigrationSync.
 */
export function MigrationBanner({ serverId }: { serverId: string }) {
  useJobsLive();
  const jobs = useJobs({ serverId });
  useMigrationSync(serverId, jobs.data);
  const active = activeMigrationJob(jobs.data);
  if (!active) return null;
  return (
    <div role="status" className="rounded-md border border-sky-900 bg-sky-950/40 p-3 text-sm">
      <div className="mb-2 flex justify-between gap-2"><span>{`Migration in progress · ${active.message || "…"}`}</span><span className="tabular-nums text-zinc-400">{`${active.progress}%`}</span></div>
      <ProgressBar value={active.progress} />
      <p className="mt-2 text-xs text-zinc-400">While it lasts, the server can only be viewed: other actions wait for it to finish.</p>
    </div>
  );
}
