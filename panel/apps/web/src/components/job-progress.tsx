import type { JobDto } from "@/lib/api";
import { jobTypeLabel } from "@/lib/jobs";

export function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 w-full overflow-hidden bg-obsidian shadow-[inset_0_0_0_1px_var(--cobble)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
      <div className="h-full bg-grass shadow-[inset_0_-2px_0_var(--grass-deep)] transition-[width]" style={{ width: `${v}%` }} />
    </div>
  );
}

/** Card with the job in progress (backup or restore). */
export function JobProgress({ job }: { job: JobDto }) {
  return (
    <div className="rounded-lg border border-cobble bg-bedrock/70 p-3 text-sm" aria-live="polite">
      <div className="mb-2 flex justify-between gap-2">
        <span>{jobTypeLabel(job.type)} in progress: {job.message || "…"}</span>
        <span className="tabular-nums text-muted-foreground">{job.progress}%</span>
      </div>
      <ProgressBar value={job.progress} />
    </div>
  );
}
