import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, History, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BackupScheduleForm } from "@/components/backup-schedule-form";
import { JobProgress } from "@/components/job-progress";
import { StatusBadge } from "@/components/status";
import { createBackup, newIdempotencyKey, useBackups } from "@/hooks/use-backups";
import { useJobs, useJobsLive } from "@/hooks/use-jobs";
import { api, apiPath, type BackupDto, type JobDto, type ServerDto } from "@/lib/api";
import { startDownload } from "@/lib/files";
import { backupActions, backupDownloadUrl, keepIdempotencyKey, deleteDialogText, formatBackupDate, restoreDialogText, toggleBusyReason } from "@/lib/backups";
import { formatBytes } from "@/lib/format";
import { backupsKey, isActive, TRIGGER_LABEL } from "@/lib/jobs";

export function BackupsTab({ server, nodeOnline }: { server: ServerDto; nodeOnline: boolean | undefined }) {
  useJobsLive();
  const qc = useQueryClient();
  const backups = useBackups(server.id);
  const jobs = useJobs({ serverId: server.id });
  const active = jobs.data?.find((j) => isActive(j) && (j.type === "backup" || j.type === "restore"));
  const [restoring, setRestoring] = useState<BackupDto | null>(null);
  const [deleting, setDeleting] = useState<BackupDto | null>(null);
  const refreshJobs = () => qc.invalidateQueries({ queryKey: ["jobs"] });

  // One key per intent: only a failure without a server response keeps it for the retry.
  const createKey = useRef<string | null>(null);
  const createNow = useMutation({
    mutationFn: () => createBackup(server.id, (createKey.current ??= newIdempotencyKey())),
    onSuccess: () => { createKey.current = null; return refreshJobs(); },
    onError: (e) => { if (!keepIdempotencyKey(e)) createKey.current = null; },
  });
  const restore = useMutation({
    mutationFn: (b: BackupDto) => api.post<JobDto>(apiPath`/api/servers/${server.id}/backups/${b.id}/restore`),
    onSuccess: () => { setRestoring(null); void refreshJobs(); },
  });
  const remove = useMutation({
    mutationFn: (b: BackupDto) => api.del<void>(apiPath`/api/servers/${server.id}/backups/${b.id}`),
    onSuccess: () => { setDeleting(null); void qc.invalidateQueries({ queryKey: backupsKey(server.id) }); },
  });
  const offline = nodeOnline === false;
  const busyReason = toggleBusyReason(nodeOnline, active);
  const busy = busyReason !== null;
  const error = createNow.error ?? restore.error ?? remove.error;
  const del = deleting ? deleteDialogText(deleting) : null;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3" aria-label="Backups">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-bone">Backups</h2>
            <p className="text-xs text-muted-foreground">On the node's disk, in {server.slug}/backups.</p>
          </div>
          <Button onClick={() => { restore.reset(); remove.reset(); createNow.mutate(); }} disabled={busy || createNow.isPending} title={busyReason ?? undefined}>
            <DatabaseBackup className="size-4" /> Create backup now
          </Button>
        </div>
        {active && <JobProgress job={active} />}
        {error && <p role="alert" className="text-sm text-bad">{error.message}</p>}
        <Table>
          <TableHeader>
            <TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Size</TableHead><TableHead>Spec</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {backups.isPending && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Loading backups…</TableCell></TableRow>}
            {backups.isError && <TableRow><TableCell colSpan={5} className="text-center text-bad">Could not load the backups: {backups.error.message}</TableCell></TableRow>}
            {backups.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No backups yet. Create one now or set up scheduled backups below.</TableCell></TableRow>}
            {backups.data?.map((b) => {
              const act = backupActions(b, busy, offline);
              return (
                <TableRow key={b.id} data-testid={`backup-row-${b.filename}`}>
                  <TableCell><div>{formatBackupDate(b.startedAt)}</div><div className="font-mono text-xs text-muted-foreground">{b.filename}</div></TableCell>
                  <TableCell>
                    <Badge variant={b.kind === "directory" ? "outline" : "secondary"}>{TRIGGER_LABEL[b.trigger]}</Badge>
                    {b.status === "failed" && <StatusBadge tone="bad" className="ml-1">Failed</StatusBadge>}
                  </TableCell>
                  <TableCell>{b.sizeBytes ? formatBytes(b.sizeBytes) : "—"}</TableCell>
                  <TableCell>{b.specVersion ? `v${b.specVersion}` : "—"}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {b.kind === "archive" && (
                        <Button size="sm" variant="outline" disabled={!act.restore} onClick={() => { restore.reset(); setRestoring(b); }}><History className="size-4" /> Restore</Button>
                      )}
                      {act.showDownload && (
                        <Button size="sm" variant="ghost" disabled={!act.download} title={act.download ? "Download" : "The backup cannot be downloaded right now"}
                          onClick={() => startDownload(backupDownloadUrl(server.id, b.id), b.filename)}>
                          <Download className="size-4" /><span className="sr-only">Download {b.filename}</span>
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={!act.remove || remove.isPending} onClick={() => { remove.reset(); setDeleting(b); }}><Trash2 className="size-4" /><span className="sr-only">Delete {b.filename}</span></Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3" aria-label="Schedule">
        <h2 className="text-base font-semibold text-bone">Schedule</h2>
        <BackupScheduleForm server={server} />
      </section>

      <AlertDialog open={restoring !== null} onOpenChange={(open) => { if (!open && !restore.isPending) setRestoring(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              {restoring ? restoreDialogText(server.name, restoring.startedAt) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restore.error && <p role="alert" className="text-sm text-bad">{restore.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={restore.isPending} onClick={(e) => { e.preventDefault(); if (restoring) restore.mutate(restoring); }}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{del?.title}</AlertDialogTitle>
            <AlertDialogDescription>{del?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error && <p role="alert" className="text-sm text-bad">{remove.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={(e) => { e.preventDefault(); if (deleting) remove.mutate(deleting); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
