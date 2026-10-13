import type { JobDto } from "@/lib/api";
import { jobTypeLabel } from "@/lib/jobs";

export function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
      <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${v}%` }} />
    </div>
  );
}

/** Card with the job in progress (backup or restore). */
export function JobProgress({ job }: { job: JobDto }) {
  return (
    <div className="rounded-md border border-zinc-800 p-3 text-sm" aria-live="polite">
      <div className="mb-2 flex justify-between gap-2">
        <span>{jobTypeLabel(job.type)} in progress: {job.message || "…"}</span>
        <span className="tabular-nums text-zinc-400">{job.progress}%</span>
      </div>
      <ProgressBar value={job.progress} />
    </div>
  );
}
