import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JobList } from "@/components/job-list";
import type { JobState } from "@/lib/api";
import { JOB_FILTER_OPTIONS, jobsFilterFor } from "@/lib/jobs";

export function JobsPage() {
  const [status, setStatus] = useState<JobState | null>(null);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <div className="flex gap-1" role="group" aria-label="Filtrar por estado">
          {JOB_FILTER_OPTIONS.map((f) => (
            <Button key={f.label} size="sm" variant={status === f.value ? "secondary" : "ghost"} aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>{f.label}</Button>
          ))}
        </div>
      </header>
      <JobList filter={jobsFilterFor(status)} />
    </div>
  );
}
