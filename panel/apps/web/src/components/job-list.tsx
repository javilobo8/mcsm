import { Fragment, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProgressBar } from "@/components/job-progress";
import { useJob, useJobs, useJobsLive } from "@/hooks/use-jobs";
import { useServers } from "@/hooks/use-servers";
import type { JobState } from "@/lib/api";
import { formatBackupDate } from "@/lib/backups";
import { formatFinishTime, isActive, JOB_STATUS_LABEL, jobTriggerLabel, jobTypeLabel, type JobsFilter } from "@/lib/jobs";

const VARIANT: Record<JobState, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline", running: "secondary", ok: "default", failed: "destructive", cancelled: "outline",
};

/** Tabla de jobs en vivo; el botón de cada fila despliega su log. */
export function JobList({ filter, showServer = true }: { filter: JobsFilter; showServer?: boolean }) {
  useJobsLive();
  const jobs = useJobs(filter);
  const servers = useServers();
  const [open, setOpen] = useState<string | null>(null);
  const serverName = (id: string) => servers.data?.find((s) => s.id === id)?.name ?? "(borrado)";
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
        {jobs.data?.length === 0 && <TableRow><TableCell colSpan={cols} className="text-center text-zinc-400">No hay jobs.</TableCell></TableRow>}
        {jobs.data?.map((j) => {
          const trigger = jobTriggerLabel(j);
          const isOpen = open === j.id;
          const logId = `job-log-${j.id}`;
          const finish = formatFinishTime(j.finishedAt);
          return (
            <Fragment key={j.id}>
              <TableRow data-testid={`job-row-${j.id}`}>
                <TableCell>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-ring"
                    aria-expanded={isOpen}
                    aria-controls={logId}
                    aria-label={`${isOpen ? "Ocultar" : "Ver"} log de ${jobTypeLabel(j.type)}`}
                    onClick={() => setOpen(isOpen ? null : j.id)}
                  >
                    {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </button>
                </TableCell>
                <TableCell>{jobTypeLabel(j.type)}{trigger && <span className="ml-1 text-xs text-zinc-500">({trigger.toLowerCase()})</span>}</TableCell>
                {showServer && (
                  <TableCell>
                    {j.serverId
                      ? <Link to="/servers/$serverId" params={{ serverId: j.serverId }} className="hover:underline">{serverName(j.serverId)}</Link>
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
        })}
      </TableBody>
    </Table>
  );
}

function JobLog({ id }: { id: string }) {
  const q = useJob(id);
  if (q.isPending) return <p className="text-xs text-zinc-400">Cargando log…</p>;
  if (q.isError) return <p className="text-xs text-red-400">No se pudo cargar el log: {q.error.message}</p>;
  return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-black p-3 font-mono text-xs text-zinc-300">{q.data.log || "(sin log)"}</pre>;
}
