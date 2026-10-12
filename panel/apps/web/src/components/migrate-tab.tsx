import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Check, Circle, Loader2, X } from "lucide-react";
import { MIGRATION_STEPS } from "@mcsm/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProgressBar } from "@/components/job-progress";
import { useTabGuard } from "@/components/guarded-tabs";
import { useJobs, useJobsLive } from "@/hooks/use-jobs";
import { closeMigration, startMigration, useMigration, useMigrationProposal } from "@/hooks/use-migration";
import { useNodes } from "@/hooks/use-nodes";
import type { JobDto, ServerDto } from "@/lib/api";
import {
  activeMigrationJob, canCloseMigration, closeMigrationText, confirmText, lastMigrationJob, migrateBlockedReason, migrateFormDirty, migrationBody, migrationKey,
  parsePortInput, pendingText, portHint, stepStates, targetOptions, type StepState,
} from "@/lib/migration";
import { cn } from "@/lib/utils";

const ICON: Record<StepState, React.ReactNode> = {
  done: <Check className="size-4 text-emerald-400" aria-hidden />,
  current: <Loader2 className="size-4 animate-spin" aria-hidden />,
  failed: <X className="size-4 text-red-400" aria-hidden />,
  pending: <Circle className="size-4 text-zinc-600" aria-hidden />,
};

/** Los 7 pasos de la migración con su estado según el job. */
export function MigrationSteps({ job }: { job: Pick<JobDto, "progress" | "status"> }) {
  const states = stepStates(job);
  return (
    <ol className="flex flex-col gap-1 text-sm" aria-label="Pasos de la migración">
      {MIGRATION_STEPS.map((label, i) => (
        <li key={label} aria-current={states[i] === "current" ? "step" : undefined}
          className={cn("flex items-center gap-2", states[i] === "pending" && "text-zinc-500", states[i] === "failed" && "text-red-400")}>
          {ICON[states[i]!]}<span>{`${i + 1}. ${label}`}</span>
        </li>
      ))}
    </ol>
  );
}

export function MigrateTab({ server, nodeOnline }: { server: ServerDto; nodeOnline: boolean | undefined }) {
  useJobsLive();
  const qc = useQueryClient();
  const nodes = useNodes();
  const jobs = useJobs({ serverId: server.id });
  const migration = useMigration(server.id);
  const [targetId, setTargetId] = useState("");
  const [portText, setPortText] = useState("");
  const [deleteSource, setDeleteSource] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  // Elegir destino y puerto no es mucho trabajo, pero se avisa antes de perderlo al cambiar de pestaña (m9).
  useTabGuard(migrateFormDirty(targetId, portText, deleteSource), {
    title: "Migración sin lanzar", description: "Has elegido a dónde migrar el servidor. Si cambias de pestaña se perderá la selección.", confirmLabel: "Descartar y cambiar",
  });

  const active = activeMigrationJob(jobs.data);
  const last = lastMigrationJob(jobs.data);
  const options = targetOptions(nodes.data, server.nodeId);
  const target = options.find((o) => o.id === targetId);
  const port = parsePortInput(portText);
  // Con el puerto escrito, la propuesta comprueba ese puerto (m8): su error solo bloquea si de verdad no vale.
  const proposal = useMigrationProposal(server.id, target && !target.disabled ? target.id : null, port ?? undefined);
  const nodeName = (id: string) => nodes.data?.find((n) => n.id === id)?.name ?? "otro nodo";
  const nodeOnlineById = (id: string) => (nodes.data ? nodes.data.find((n) => n.id === id)?.status === "online" : undefined);
  const pending = migration.data ? pendingText(migration.data, nodeName, nodeOnlineById) : null;
  const closable = canCloseMigration(migration.data, active);
  const blocked = migrateBlockedReason({
    sourceOnline: nodeOnline, active, migration: migration.data, target, portInvalid: port === null, proposalError: proposal.error?.message ?? null,
  });
  const finalPort = port ?? proposal.data?.port;

  const close = useMutation({
    mutationFn: () => closeMigration(server.id),
    onSuccess: () => {
      setClosing(false);
      void qc.invalidateQueries({ queryKey: migrationKey(server.id) });
      void qc.invalidateQueries({ queryKey: ["server", server.id] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const start = useMutation({
    mutationFn: () => startMigration(server.id, migrationBody(targetId, port ?? undefined, deleteSource)),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: migrationKey(server.id) });
    },
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Migración">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-400">Migrar a otro nodo</h2>
          <p className="text-xs text-zinc-500">
            Mueve el mundo, la configuración y el historial de «{server.name}» a otro nodo: copia previa, envío por el panel con
            sha256 comprobado, restauración y arranque de prueba en el destino. Si algo falla, el servidor sigue aquí intacto.
          </p>
        </div>
        {active && (
          <div className="rounded-md border border-zinc-800 p-3" aria-live="polite">
            <div className="mb-2 flex justify-between gap-2 text-sm"><span>{active.message || "…"}</span><span className="tabular-nums text-zinc-400">{`${active.progress}%`}</span></div>
            <ProgressBar value={active.progress} />
            <div className="mt-3"><MigrationSteps job={active} /></div>
          </div>
        )}
        {!active && last?.status === "failed" && (
          <div role="alert" className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            <p>La última migración falló: {last.message}</p>
            <div className="mt-3"><MigrationSteps job={last} /></div>
          </div>
        )}
        {!active && last?.status === "ok" && <p className="text-sm text-emerald-400">{last.message}</p>}
        {pending && <p role="status" className="text-sm text-amber-400">{pending}</p>}
        {closable && (
          <div>
            <Button variant="outline" size="sm" onClick={() => { close.reset(); setClosing(true); }}>Cerrar la migración a mano…</Button>
          </div>
        )}
      </section>

      {!active && (
        <section className="flex flex-col gap-4" aria-label="Nueva migración">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mig-target">Nodo destino</Label>
            <Select value={targetId} onValueChange={(v) => { setTargetId(v); setPortText(""); start.reset(); }}>
              <SelectTrigger id="mig-target" className="w-72">
                <SelectValue placeholder={nodes.isPending ? "Cargando nodos…" : options.length ? "Elige un nodo" : "No hay otros nodos"} />
              </SelectTrigger>
              <SelectContent>{options.map((o) => <SelectItem key={o.id} value={o.id} disabled={o.disabled}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mig-port">Puerto de juego en el destino</Label>
            <Input id="mig-port" className="w-40" inputMode="numeric" disabled={!target} value={portText}
              placeholder={proposal.data ? String(proposal.data.port) : ""}
              onChange={(e) => { setPortText(e.target.value); start.reset(); }} />
            <p className="text-xs text-zinc-500">{portHint(proposal.data, port)}</p>
            {proposal.isError && <p role="alert" className="text-xs text-red-400">{proposal.error.message}</p>}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} />
            <span>{`Borrar el origen al terminar (sus datos y sus copias en este nodo). Si no, se conservan en ${server.slug}.migrated-….`}</span>
          </label>
          {start.error && <p role="alert" className="text-sm text-red-400">{start.error.message}</p>}
          <div className="flex items-center gap-3">
            <Button onClick={() => { start.reset(); setConfirming(true); }} disabled={blocked !== null || finalPort === undefined} title={blocked ?? undefined}>
              <ArrowRightLeft className="size-4" /> Migrar…
            </Button>
            {blocked && <span className="text-xs text-zinc-500">{blocked}</span>}
          </div>
        </section>
      )}

      <AlertDialog open={closing} onOpenChange={(open) => { if (!close.isPending) setClosing(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cerrar a mano la migración de «{server.name}»?</AlertDialogTitle>
            <AlertDialogDescription>{migration.data ? closeMigrationText(migration.data, nodeName) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          {close.error && <p role="alert" className="text-sm text-red-400">{close.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={close.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={close.isPending} onClick={(e) => { e.preventDefault(); close.mutate(); }}>
              {close.isPending ? "Cerrando…" : "Cerrar la migración"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!start.isPending) setConfirming(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Migrar «{server.name}» a «{target?.label ?? ""}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {finalPort !== undefined ? confirmText({
                serverName: server.name, slug: server.slug, source: nodeName(server.nodeId), target: target?.label ?? "", port: finalPort,
                deleteSource, running: server.desiredState === "running",
              }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {start.error && <p role="alert" className="text-sm text-red-400">{start.error.message}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={start.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant={deleteSource ? "destructive" : "default"} disabled={start.isPending}
              onClick={(e) => { e.preventDefault(); start.mutate(); }}>
              {start.isPending ? "Iniciando…" : "Migrar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
