import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, History, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BackupScheduleForm } from "@/components/backup-schedule-form";
import { JobProgress } from "@/components/job-progress";
import { createBackup, newIdempotencyKey, useBackups } from "@/hooks/use-backups";
import { useJobs, useJobsLive } from "@/hooks/use-jobs";
import { api, apiPath, type BackupDto, type JobDto, type ServerDto } from "@/lib/api";
import { backupActions, keepIdempotencyKey, deleteDialogText, formatBackupDate, toggleBusyReason } from "@/lib/backups";
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

  // Una clave por intención: solo un fallo sin respuesta del servidor la conserva para el reintento.
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
      <section className="flex flex-col gap-3" aria-label="Copias">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Copias de seguridad</h2>
            <p className="text-xs text-zinc-500">En el disco del nodo, en {server.slug}/backups.</p>
          </div>
          <Button onClick={() => { restore.reset(); remove.reset(); createNow.mutate(); }} disabled={busy || createNow.isPending} title={busyReason ?? undefined}>
            <DatabaseBackup className="size-4" /> Crear copia ahora
          </Button>
        </div>
        {active && <JobProgress job={active} />}
        {error && <p role="alert" className="text-sm text-red-400">{error.message}</p>}
        <Table>
          <TableHeader>
            <TableRow><TableHead>Fecha</TableHead><TableHead>Tipo</TableHead><TableHead>Tamaño</TableHead><TableHead>Spec</TableHead><TableHead><span className="sr-only">Acciones</span></TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {backups.isPending && <TableRow><TableCell colSpan={5} className="text-center text-zinc-400">Cargando copias…</TableCell></TableRow>}
            {backups.isError && <TableRow><TableCell colSpan={5} className="text-center text-red-400">No se pudieron cargar las copias: {backups.error.message}</TableCell></TableRow>}
            {backups.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-zinc-400">Aún no hay copias. Crea una ahora o programa copias automáticas abajo.</TableCell></TableRow>}
            {backups.data?.map((b) => {
              const act = backupActions(b, busy, offline);
              return (
                <TableRow key={b.id} data-testid={`backup-row-${b.filename}`}>
                  <TableCell><div>{formatBackupDate(b.startedAt)}</div><div className="font-mono text-xs text-zinc-500">{b.filename}</div></TableCell>
                  <TableCell>
                    <Badge variant={b.kind === "directory" ? "outline" : "secondary"}>{TRIGGER_LABEL[b.trigger]}</Badge>
                    {b.status === "failed" && <Badge variant="destructive" className="ml-1">Fallida</Badge>}
                  </TableCell>
                  <TableCell>{b.sizeBytes ? formatBytes(b.sizeBytes) : "—"}</TableCell>
                  <TableCell>{b.specVersion ? `v${b.specVersion}` : "—"}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {b.kind === "archive" && (
                        <Button size="sm" variant="outline" disabled={!act.restore} onClick={() => { restore.reset(); setRestoring(b); }}><History className="size-4" /> Restaurar</Button>
                      )}
                      {act.showDownload && (
                        <Button size="sm" variant="ghost" disabled title="La descarga estará disponible con el gestor de archivos"><Download className="size-4" /><span className="sr-only">Descargar</span></Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={!act.remove || remove.isPending} onClick={() => { remove.reset(); setDeleting(b); }}><Trash2 className="size-4" /><span className="sr-only">Borrar {b.filename}</span></Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3" aria-label="Programación">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Programación</h2>
        <BackupScheduleForm server={server} />
      </section>

      <AlertDialog open={restoring !== null} onOpenChange={(open) => { if (!open && !restore.isPending) setRestoring(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Restaurar esta copia?</AlertDialogTitle>
            <AlertDialogDescription>
              Restaurar sustituye el mundo actual de «{server.name}» por el de la copia del {restoring ? formatBackupDate(restoring.startedAt) : ""}. Se parará el servidor, los datos actuales se apartarán en un directorio data.pre-restore-… (no se borran, aparecerá en esta lista) y se extraerá la copia. Después el servidor volverá a arrancar si estaba en marcha.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restore.error && <p role="alert" className="text-sm text-red-400">{restore.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={restore.isPending} onClick={(e) => { e.preventDefault(); if (restoring) restore.mutate(restoring); }}>Restaurar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{del?.title}</AlertDialogTitle>
            <AlertDialogDescription>{del?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.error && <p role="alert" className="text-sm text-red-400">{remove.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={(e) => { e.preventDefault(); if (deleting) remove.mutate(deleting); }}>Borrar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
