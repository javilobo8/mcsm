import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JobList } from "@/components/job-list";
import { JOB_FILTER_OPTIONS, jobsFilterFor } from "@/lib/jobs";

export function JobsPage() {
  const [selected, setSelected] = useState(JOB_FILTER_OPTIONS[0]!);
  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <div className="flex gap-1" role="group" aria-label="Filtrar por estado">
          {JOB_FILTER_OPTIONS.map((f) => (
            <Button key={f.label} size="sm" variant={selected === f ? "secondary" : "ghost"} aria-pressed={selected === f} onClick={() => setSelected(f)}>{f.label}</Button>
          ))}
        </div>
      </header>
      <JobList filter={jobsFilterFor(selected.status)} />
    </div>
  );
}
