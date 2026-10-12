import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProgressBar } from "@/components/job-progress";
import { useJob, useJobs, useJobsLive } from "@/hooks/use-jobs";
import { useServers } from "@/hooks/use-servers";
import type { JobDto, JobState } from "@/lib/api";
import { formatBackupDate } from "@/lib/backups";
import { formatFinishTime, isActive, JOB_STATUS_LABEL, jobsKey, jobServerName, jobTriggerLabel, jobTypeLabel, openRowId, withOpenRow, type JobsFilter, type OpenRow } from "@/lib/jobs";

const VARIANT: Record<JobState, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline", running: "secondary", ok: "default", failed: "destructive", cancelled: "outline",
};

/**
 * Tabla de jobs en vivo; el botón de cada fila despliega su log. La fila abierta no desaparece si su job deja de
 * cumplir el filtro (termina con «En curso»): sigue hasta que se pliegue o cambie el filtro.
 */
export function JobList({ filter, showServer = true }: { filter: JobsFilter; showServer?: boolean }) {
  useJobsLive();
  const jobs = useJobs(filter);
  const servers = useServers();
  const filterKey = JSON.stringify(jobsKey(filter));
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);
  const open = openRowId(openRow, filterKey);
  const toggle = useCallback((id: string) => setOpenRow((cur) => (openRowId(cur, filterKey) === id ? null : { id, filterKey })), [filterKey]);
  const openJob = useJob(open); // la misma consulta que el log de la fila abierta
  const rows = jobs.data ? withOpenRow(jobs.data, open, openJob.data) : undefined;
  const cols = showServer ? 6 : 5;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"><span className="sr-only">Detalle</span></TableHead>
          <TableHead>Tipo</TableHead>
          {showServer && <TableHead>Servidor</TableHead>}
          <TableHead>Estado</TableHead>
          <TableHead>Progreso</TableHead>
          <TableHead>Inicio</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.isPending && <TableRow><TableCell colSpan={cols} className="text-center text-zinc-400">Cargando…</TableCell></TableRow>}
        {jobs.isError && <TableRow><TableCell colSpan={cols} className="text-center text-red-400">No se pudieron cargar los jobs: {jobs.error.message}</TableCell></TableRow>}
        {rows?.length === 0 && <TableRow><TableCell colSpan={cols} className="text-center text-zinc-400">No hay jobs.</TableCell></TableRow>}
        {rows?.map((j) => (
          <JobRow key={j.id} job={j} cols={cols} showServer={showServer} isOpen={open === j.id} onToggle={toggle}
            serverLabel={j.serverId ? jobServerName(j.serverId, servers.data) : null} />
        ))}
      </TableBody>
    </Table>
  );
}

interface JobRowProps { job: JobDto; cols: number; showServer: boolean; isOpen: boolean; serverLabel: string | null; onToggle: (id: string) => void }

/** Memoizada: un trozo de log solo cambia el job que lo recibe, no las demás filas. */
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
            className="rounded p-0.5 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={isOpen}
            aria-controls={isOpen ? logId : undefined}
            aria-label={`${isOpen ? "Ocultar" : "Ver"} log de ${jobTypeLabel(j.type)}`}
            onClick={() => onToggle(j.id)}
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </TableCell>
        <TableCell>{jobTypeLabel(j.type)}{trigger && <span className="ml-1 text-xs text-zinc-500">({trigger.toLowerCase()})</span>}</TableCell>
        {showServer && (
          <TableCell>
            {j.serverId
              ? <Link to="/servers/$serverId" params={{ serverId: j.serverId }} className="hover:underline">{serverLabel}</Link>
              : <span className="text-zinc-500">—</span>}
          </TableCell>
        )}
        <TableCell>
          <Badge variant={VARIANT[j.status]}>{JOB_STATUS_LABEL[j.status]}</Badge>
          {j.message && <div className="mt-1 max-w-md truncate text-xs text-zinc-400" title={j.message}>{j.message}</div>}
        </TableCell>
        <TableCell className="w-40">{isActive(j) ? <ProgressBar value={j.progress} /> : <span className="text-xs text-zinc-500">{j.progress}%</span>}</TableCell>
        <TableCell className="text-xs text-zinc-400">
          {formatBackupDate(j.createdAt)}
          {finish && <div>fin {finish}</div>}
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
  // Sigue el final del log solo si el usuario ya estaba abajo.
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  if (q.isPending) return <p className="text-xs text-zinc-400">Cargando log…</p>;
  if (!q.data) return <p className="text-xs text-red-400">No se pudo cargar el log: {q.error?.message}</p>;
  return (
    <div>
      {q.isError && <p className="mb-1 text-xs text-amber-400">No se pudo actualizar el log: {q.error.message}</p>}
      <pre
        ref={preRef}
        tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX; }}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-black p-3 font-mono text-xs text-zinc-300"
      >{q.data.log || "(sin log)"}</pre>
    </div>
  );
}
