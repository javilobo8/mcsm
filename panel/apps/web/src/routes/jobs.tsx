import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JobList } from "@/components/job-list";
import { PAGE, PageHeader } from "@/components/page-header";
import { JOB_FILTER_OPTIONS, jobsFilterFor } from "@/lib/jobs";

export function JobsPage() {
  const [selected, setSelected] = useState(JOB_FILTER_OPTIONS[0]!);
  return (
    <div className={PAGE}>
      <PageHeader
        title="Jobs"
        description="Backups, restores and migrations across every node, with their progress and logs."
        actions={
          <div className="flex gap-1" role="group" aria-label="Filter by status">
            {JOB_FILTER_OPTIONS.map((f) => (
              <Button key={f.label} size="sm" variant={selected === f ? "secondary" : "ghost"} aria-pressed={selected === f} onClick={() => setSelected(f)}>{f.label}</Button>
            ))}
          </div>
        }
      />
      <JobList filter={jobsFilterFor(selected.status)} />
    </div>
  );
}
