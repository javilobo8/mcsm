import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StatusBadge, type Tone } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProgressBar } from "@/components/job-progress";
import { useJob, useJobs, useJobsLive } from "@/hooks/use-jobs";
import { useServers } from "@/hooks/use-servers";
import type { JobDto, JobState } from "@/lib/api";
import { formatBackupDate } from "@/lib/backups";
import { formatFinishTime, isActive, JOB_STATUS_LABEL, jobsKey, jobServerName, jobTriggerLabel, jobTypeLabel, openRowId, withOpenRow, type JobsFilter, type OpenRow } from "@/lib/jobs";

const TONE: Record<JobState, Tone> = {
  queued: "muted", running: "info", ok: "ok", failed: "bad", cancelled: "muted",
};

/**
 * Live jobs table; each row's button expands its log. The open row does not disappear if its job stops
 * matching the filter (it ends while on “Running”): it stays until it is collapsed or the filter changes.
 */
export function JobList({ filter, showServer = true }: { filter: JobsFilter; showServer?: boolean }) {
  useJobsLive();
  const jobs = useJobs(filter);
  const servers = useServers();
  const filterKey = JSON.stringify(jobsKey(filter));
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);
  const open = openRowId(openRow, filterKey);
  const toggle = useCallback((id: string) => setOpenRow((cur) => (openRowId(cur, filterKey) === id ? null : { id, filterKey })), [filterKey]);
  const openJob = useJob(open); // the same query as the open row's log
  const rows = jobs.data ? withOpenRow(jobs.data, open, openJob.data) : undefined;
  const cols = showServer ? 6 : 5;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
          <TableHead>Type</TableHead>
          {showServer && <TableHead>Server</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Start</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.isPending && <TableRow><TableCell colSpan={cols} className="text-center text-muted-foreground">Loading…</TableCell></TableRow>}
        {jobs.isError && <TableRow><TableCell colSpan={cols} className="text-center text-bad">Could not load the jobs: {jobs.error.message}</TableCell></TableRow>}
        {rows?.length === 0 && <TableRow><TableCell colSpan={cols} className="text-center text-muted-foreground">No jobs.</TableCell></TableRow>}
        {rows?.map((j) => (
          <JobRow key={j.id} job={j} cols={cols} showServer={showServer} isOpen={open === j.id} onToggle={toggle}
            serverLabel={j.serverId ? jobServerName(j.serverId, servers.data) : null} />
        ))}
      </TableBody>
    </Table>
  );
}

interface JobRowProps { job: JobDto; cols: number; showServer: boolean; isOpen: boolean; serverLabel: string | null; onToggle: (id: string) => void }

/** Memoized: a log chunk only changes the job that receives it, not the other rows. */
const JobRow = memo(function JobRow({ job: j, cols, showServer, isOpen, serverLabel, onToggle }: JobRowProps) {
  const trigger = jobTriggerLabel(j);
  const logId = `job-log-${j.id}`;
  const finish = formatFinishTime(j.finishedAt);
  return (
    <Fragment>
      <TableRow data-testid={`job-row-${j.id}`}>
        <TableCell>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={isOpen}
            aria-controls={isOpen ? logId : undefined}
            aria-label={`${isOpen ? "Hide" : "View"} log of ${jobTypeLabel(j.type)}`}
            onClick={() => onToggle(j.id)}
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </TableCell>
        <TableCell>{jobTypeLabel(j.type)}{trigger && <span className="ml-1 text-xs text-muted-foreground">({trigger.toLowerCase()})</span>}</TableCell>
        {showServer && (
          <TableCell>
            {j.serverId
              ? <Link to="/servers/$serverId" params={{ serverId: j.serverId }} className="hover:underline">{serverLabel}</Link>
              : <span className="text-muted-foreground">—</span>}
          </TableCell>
        )}
        <TableCell>
          <StatusBadge tone={TONE[j.status]}>{JOB_STATUS_LABEL[j.status]}</StatusBadge>
          {j.message && <div className="mt-1 max-w-md truncate text-xs text-muted-foreground" title={j.message}>{j.message}</div>}
        </TableCell>
        <TableCell className="w-40">{isActive(j) ? <ProgressBar value={j.progress} /> : <span className="text-xs text-muted-foreground">{j.progress}%</span>}</TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatBackupDate(j.createdAt)}
          {finish && <div>end {finish}</div>}
        </TableCell>
      </TableRow>
      {isOpen && <TableRow id={logId}><TableCell colSpan={cols}><JobLog id={j.id} /></TableCell></TableRow>}
    </Fragment>
  );
});

const BOTTOM_SLACK_PX = 8;

function JobLog({ id }: { id: string }) {
  const q = useJob(id);
  const preRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const log = q.data?.log;
  // Follows the end of the log only if the user was already at the bottom.
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  if (q.isPending) return <p className="text-xs text-muted-foreground">Loading log…</p>;
  if (!q.data) return <p className="text-xs text-bad">Could not load the log: {q.error?.message}</p>;
  return (
    <div>
      {q.isError && <p className="mb-1 text-xs text-warn">Could not refresh the log: {q.error.message}</p>}
      <pre
        ref={preRef}
        tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX; }}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-cobble bg-obsidian p-3 font-mono text-xs leading-[1.65] text-log"
      >{q.data.log || "(no log)"}</pre>
    </div>
  );
}
