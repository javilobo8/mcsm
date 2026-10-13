import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { BackupsConfig } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useTabGuard } from "@/components/guarded-tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiPath, type ServerDto } from "@/lib/api";
import { CRON_PRESETS, formToSchedule, presetFor, resyncSchedule, scheduleDirty, scheduleLeaveWarning, scheduleToForm, type ScheduleForm } from "@/lib/backups";

/** Programación y retención de copias: PATCH de `spec.backups` (no forma parte del formulario de configuración). */
export function BackupScheduleForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const incoming = scheduleToForm(server.spec.backups);
  const incomingJson = JSON.stringify(incoming);
  const [f, setF] = useState<ScheduleForm>(incoming);
  const [base, setBase] = useState<{ form: ScheduleForm; json: string }>({ form: incoming, json: incomingJson });
  if (base.json !== incomingJson) { // la spec cambió: adoptar solo sin cambios sin guardar
    const r = resyncSchedule(f, base.form, incoming);
    setF(r.form);
    setBase({ form: r.base, json: incomingJson });
  }
  const [localErr, setLocalErr] = useState<string | null>(null);

  // ★ del Plan 4: cambios sin guardar protegidos como en Configuración y Archivos.
  const leave = scheduleLeaveWarning(scheduleDirty(f, base.form));
  const guarded = leave !== null;
  const lastLeave = useRef(leave);
  if (leave) lastLeave.current = leave;
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !guarded, enableBeforeUnload: () => guarded, withResolver: true });
  useTabGuard(guarded, leave ?? undefined);

  const set = <K extends keyof ScheduleForm>(k: K, v: ScheduleForm[K]) => { if (save.isSuccess) save.reset(); setF((o) => ({ ...o, [k]: v })); };
  const save = useMutation({
    mutationFn: ({ cfg }: { cfg: BackupsConfig; sent: ScheduleForm }) => api.patch<ServerDto>(apiPath`/api/servers/${server.id}/backups/schedule`, cfg),
    onSuccess: (dto, { sent }) => {
      qc.setQueryData(["server", server.id], dto);
      // Lo editado mientras se guardaba no se pisa: solo se adopta lo guardado si el formulario sigue como se envió.
      const saved = scheduleToForm(dto.spec.backups);
      setF((cur) => resyncSchedule(cur, sent, saved).form);
      setBase({ form: saved, json: JSON.stringify(saved) });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalErr(null);
    save.reset();
    const r = formToSchedule(f);
    if (!r.ok) return setLocalErr(r.error);
    save.mutate({ cfg: r.value, sent: f });
  };
  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Copias automáticas
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-preset">Frecuencia</Label>
          <Select value={presetFor(f.cron)} onValueChange={(v) => { const p = CRON_PRESETS.find((x) => x.value === v); if (p?.cron) set("cron", p.cron); }}>
            <SelectTrigger id="backup-preset"><SelectValue /></SelectTrigger>
            <SelectContent>{CRON_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-cron">Expresión cron (hora del nodo)</Label>
          <Input id="backup-cron" value={f.cron} onChange={(e) => set("cron", e.target.value)} className="font-mono" placeholder="0 4 * * *" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-days">Conservar días (0 = sin límite)</Label>
          <Input id="backup-days" inputMode="numeric" value={f.keepDays} onChange={(e) => set("keepDays", e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-count">Conservar copias (0 = sin límite)</Label>
          <Input id="backup-count" inputMode="numeric" value={f.keepCount} onChange={(e) => set("keepCount", e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        La retención solo borra copias programadas (nunca la más reciente). Las manuales y los datos previos a una restauración se conservan hasta que los borres.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-emerald-500" checked={f.onlyIfPlayersSince} onChange={(e) => set("onlyIfPlayersSince", e.target.checked)} />
        Solo si alguien ha jugado desde la última copia
      </label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backup-excludes">Excluir (un patrón por línea)</Label>
        <Textarea id="backup-excludes" rows={4} className="font-mono text-xs" value={f.excludes} onChange={(e) => set("excludes", e.target.value)} />
        <p className="text-xs text-zinc-500">
          Un nombre sin «/» se excluye a cualquier profundidad (logs, *.tmp); con «/», la ruta exacta (world/session.lock). Añade *.jar para no copiar los .jar que la imagen vuelve a descargar (ojo: también los subidos a mano).
        </p>
      </div>
      {(localErr || save.error) && <p role="alert" className="text-sm text-red-400">{localErr ?? save.error?.message}</p>}
      {save.isSuccess && <p className="text-sm text-emerald-400">Programación guardada (spec v{save.data.specVersion}).</p>}
      <div><Button type="submit" disabled={save.isPending}>Guardar programación</Button></div>
      <ConfirmDialog open={blocker.status === "blocked"} title={lastLeave.current?.title ?? "Salir"} description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Salir"} cancelLabel="Quedarme" onConfirm={() => blocker.proceed?.()} onCancel={() => blocker.reset?.()} />
    </form>
  );
}
