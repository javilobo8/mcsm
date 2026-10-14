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

/** Schedule and retention of backups: PATCH of `spec.backups` (not part of the configuration form). */
export function BackupScheduleForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const incoming = scheduleToForm(server.spec.backups);
  const incomingJson = JSON.stringify(incoming);
  const [f, setF] = useState<ScheduleForm>(incoming);
  const [base, setBase] = useState<{ form: ScheduleForm; json: string }>({ form: incoming, json: incomingJson });
  if (base.json !== incomingJson) { // the spec changed: adopt it only if there are no unsaved changes
    const r = resyncSchedule(f, base.form, incoming);
    setF(r.form);
    setBase({ form: r.base, json: incomingJson });
  }
  const [localErr, setLocalErr] = useState<string | null>(null);

  // ★ from Plan 4: unsaved changes are protected as in Configuration and Files.
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
      // What was edited while saving is not overwritten: the saved value is adopted only if the form is still as it was sent.
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
        <input type="checkbox" className="size-4 accent-grass" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Scheduled backups
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-preset">Frequency</Label>
          <Select value={presetFor(f.cron)} onValueChange={(v) => { const p = CRON_PRESETS.find((x) => x.value === v); if (p?.cron) set("cron", p.cron); }}>
            <SelectTrigger id="backup-preset"><SelectValue /></SelectTrigger>
            <SelectContent>{CRON_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-cron">Cron expression (node time)</Label>
          <Input id="backup-cron" value={f.cron} onChange={(e) => set("cron", e.target.value)} className="font-mono" placeholder="0 4 * * *" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-days">Keep days (0 = no limit)</Label>
          <Input id="backup-days" inputMode="numeric" value={f.keepDays} onChange={(e) => set("keepDays", e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="backup-count">Keep backups (0 = no limit)</Label>
          <Input id="backup-count" inputMode="numeric" value={f.keepCount} onChange={(e) => set("keepCount", e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Retention only deletes scheduled backups (never the most recent one). Manual backups and the data saved before a restore are kept until you delete them.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-grass" checked={f.onlyIfPlayersSince} onChange={(e) => set("onlyIfPlayersSince", e.target.checked)} />
        Only if someone has played since the last backup
      </label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="backup-excludes">Exclude (one pattern per line)</Label>
        <Textarea id="backup-excludes" rows={4} className="font-mono text-xs" value={f.excludes} onChange={(e) => set("excludes", e.target.value)} />
        <p className="text-xs text-muted-foreground">
          A name without “/” is excluded at any depth (logs, *.tmp); with “/”, the exact path (world/session.lock). Add *.jar to skip the .jar files the image downloads again (note: this also skips the ones you uploaded by hand).
        </p>
      </div>
      {(localErr || save.error) && <p role="alert" className="text-sm text-bad">{localErr ?? save.error?.message}</p>}
      {save.isSuccess && <p className="text-sm text-ok">Schedule saved (spec v{save.data.specVersion}).</p>}
      <div><Button type="submit" disabled={save.isPending}>Save schedule</Button></div>
      <ConfirmDialog open={blocker.status === "blocked"} title={lastLeave.current?.title ?? "Leave"} description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Leave"} cancelLabel="Stay" onConfirm={() => blocker.proceed?.()} onCancel={() => blocker.reset?.()} />
    </form>
  );
}
