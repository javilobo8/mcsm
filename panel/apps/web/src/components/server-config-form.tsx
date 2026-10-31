import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Eye, EyeOff, X } from "lucide-react";
import { CONTENT_LISTS, CONTENT_LIST_KEYS, canonicalJson, type BackupFirstAccepted, type ContentListKey, type ContentLoader } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { JobProgress } from "@/components/job-progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SpecForm, type SpecFormErrors } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { SaveTemplateDialog } from "@/components/save-template-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useTabGuard } from "@/components/guarded-tabs";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";
import { rconAddress } from "@/lib/connect";
import { useSettings } from "@/hooks/use-settings";
import { editableSpec, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import {
  backupFirstNotice, backupFirstOutcome, backupReason, compatLookup, compatUnavailableNote, configLeaveWarning, contentFindings, isStale, patchBody, planApply,
  type PendingApply,
} from "@/lib/config-apply";
import { applyUpdates, backupOffer, uncheckedEntries, type CompatFinding } from "@/lib/content-compat";
import { listOf } from "@/lib/content-lists";
import { packChange } from "@/lib/content-pack";
import { browseTarget } from "@/lib/content-target";
import { checkUpdates, useContentLookup, useInstalledPack, type ListUpdate } from "@/hooks/use-content";
import { useJob, useJobsLive } from "@/hooks/use-jobs";
import { useWorldExists } from "@/hooks/use-world";
import { templateSaveBlock } from "@/lib/template-edit";

const toEditable = (s: ServerDto): EditableSpec => editableSpec(s.spec) as EditableSpec;

/** Configuration tab: form by sections, diff before applying and minimal PATCH (merge). */
export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [spec, setSpec] = useState<EditableSpec>(() => toEditable(server));
  // Baseline: what was loaded into the form and its version (to detect changes made elsewhere).
  const [base, setBase] = useState(() => ({ version: server.specVersion, name: server.name, spec: toEditable(server) }));
  const [formKey, setFormKey] = useState(0); // remounts the fields (which keep local text) on reload
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApply | null>(null);
  const [showRcon, setShowRcon] = useState(false);
  // plan-11: "Back up first" (checked by default when offered), the panel's chained job, and the compatibility check.
  const [backupFirst, setBackupFirst] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  // The chained job's failure inside this confirmation, and its outcome in the form (kept until dismissed: the dialog
  // may be closed while the backup runs).
  const [jobFailed, setJobFailed] = useState<string | null>(null);
  const [jobNotice, setJobNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [compatNote, setCompatNote] = useState<string | null>(null);
  const [compatError, setCompatError] = useState<string | null>(null);
  const [compatBusy, setCompatBusy] = useState(false);

  const dirty = name !== base.name || canonicalJson(spec) !== canonicalJson(base.spec);
  const stale = isStale(server.specVersion, base.version);
  const resetTo = (s: ServerDto) => {
    const sp = toEditable(s);
    setName(s.name); setSpec(sp); setBase({ version: s.specVersion, name: s.name, spec: sp });
    setErrors({}); setLocalErr(null); setFormKey((k) => k + 1);
  };
  // Only when stale/dirty change: resetTo and server are read fresh from the render in which they change (deliberately not dependencies).
  useEffect(() => { if (stale && !dirty) resetTo(server); }, [stale, dirty]); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // Unsaved changes: blocks the router navigation (dialog), the server tab change and warns when
  // closing or reloading the browser tab, like the Files editor.
  const leave = configLeaveWarning(dirty);
  const guarded = leave !== null;
  const lastLeave = useRef(leave); // the text does not disappear while the dialog closes
  if (leave) lastLeave.current = leave;
  const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !guarded, enableBeforeUnload: () => guarded, withResolver: true });
  useTabGuard(guarded, leave ?? undefined);

  // What the confirmation checks (only while it is open): pinned content that will not fit, and whether to back up.
  const confirming = pending !== null;
  const editedPack = useInstalledPack(spec.modpack);
  const basePack = useInstalledPack(base.spec.modpack);
  const lookup = useContentLookup(confirming ? CONTENT_LIST_KEYS.flatMap((list) => listOf(spec, list).map((entry) => ({ list, entry }))) : []);
  const compat = compatLookup(lookup);
  const findings = confirming && compat.metas ? contentFindings(spec, compat.metas, editedPack.info.data ?? null) : [];
  // Pinned entries the platform could not be asked about (down, rate limited, no CurseForge key) are "not checked".
  const unavailableNote = confirming ? compatUnavailableNote(compat.metas ? uncheckedEntries(spec, compat.metas) : [], lookup.isError) : null;
  const pack = packChange(base.spec.modpack, spec.modpack, basePack.versions.data?.versions);
  const mayOffer = confirming && pending.spec !== undefined && backupOffer({ base: base.spec, edited: spec, packChange: pack, hasWorld: null });
  const hasWorld = useWorldExists(server.id, base.spec.properties["level-name"] ?? "world", mayOffer);
  const offer = mayOffer && backupOffer({ base: base.spec, edited: spec, packChange: pack, hasWorld });
  const waiting = jobId !== null;

  const save = useMutation({
    mutationFn: (p: PendingApply) => api.patch<ServerDto | BackupFirstAccepted>(apiPath`/api/servers/${server.id}`, patchBody(p, offer && backupFirst)),
    onSuccess: (res) => {
      // 202: the panel backs up first and applies the change only if the backup succeeds (it owns the change from now on).
      if ("jobId" in res) { setJobFailed(null); setJobNotice(null); setJobId(res.jobId); return; }
      setPending(null); setJobNotice(null); // a plain save: an earlier back-up-first outcome no longer describes the form
      resetTo(res);
      qc.setQueryData(["server", server.id], res);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: () => setPending(null),
  });

  const onBackupApplied = async () => {
    setJobId(null);
    const dto = await api.get<ServerDto>(apiPath`/api/servers/${server.id}`).catch(() => null);
    setPending(null);
    if (dto) { resetTo(dto); qc.setQueryData(["server", server.id], dto); }
    setJobNotice(backupFirstNotice({ state: "applied" }, dto?.specVersion ?? null));
    void qc.invalidateQueries({ queryKey: ["servers"] });
  };

  // "Update to compatible versions": newest compatible version of each flagged entry for the edited server, then
  // back to the form so the admin sees (and reviews) the result.
  const updateCompatible = async (list: readonly CompatFinding[]) => {
    setCompatBusy(true); setCompatNote(null); setCompatError(null);
    try {
      const updates: ListUpdate[] = [];
      for (const key of [...new Set(list.map((f) => f.list))] as ContentListKey[]) {
        const t = browseTarget(spec, CONTENT_LISTS[key].kind, editedPack.info.data ?? null);
        if (!t.ok) continue;
        const us = await checkUpdates({ list: key, target: { gameVersion: t.target.gameVersion, loaders: t.target.loaders as ContentLoader[] }, entries: list.filter((f) => f.list === key).map((f) => f.entry) });
        updates.push(...us.map((u) => ({ ...u, list: key })));
      }
      const r = applyUpdates(spec, updates);
      setSpec(r.spec);
      const names = r.withoutVersion.map((raw) => list.find((f) => f.entry === raw)?.name ?? raw);
      setCompatNote(names.length ? `No compatible version: ${names.join(", ")}` : null);
      setPending(null);
    } catch (e) {
      // The dialog stays open: the error goes where the admin is looking.
      setCompatError(`Could not update: ${e instanceof Error ? e.message : "unexpected error"}`);
    } finally {
      setCompatBusy(false);
    }
  };

  const blocked = templateSaveBlock(name, errors);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset(); setJobNotice(null);
    if (blocked) return setLocalErr(blocked);
    const invalid = validateSpec(spec, "server");
    if (invalid) return setLocalErr(invalid);
    const plan = planApply(base.name, base.spec, name, spec);
    if (!plan.ok) return setLocalErr(plan.error);
    setBackupFirst(true); setJobFailed(null); setCompatNote(null); setCompatError(null);
    setPending(plan.pending);
  };

  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Unexpected error" : null);
  const running = server.desiredState === "running";

  const settings = useSettings();
  // Shows the APPLIED address (what the server publishes now), not unsaved form edits.
  const rcon = rconAddress(server, settings.data?.connectAddress);
  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="cf-name" label="Name"><Input id="cf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="text-sm text-muted-foreground">Slug <code className="rounded bg-muted px-1">{server.slug}</code> · container <code className="rounded bg-muted px-1">{`mcsm-${server.slug}`}</code></div>
      {server.spec.rconPassword && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>RCON password:</span>
          <code className="rounded bg-muted px-1.5 py-0.5" data-testid="rcon">{showRcon ? server.spec.rconPassword : "••••••••••••"}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowRcon((s) => !s)} aria-pressed={showRcon}>
            {showRcon ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{showRcon ? "Hide" : "Reveal"}
          </Button>
        </div>
      )}
      {rcon && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>RCON address:</span>
          <code className="select-all rounded bg-muted px-1.5 py-0.5" data-testid="rcon-address">{rcon}</code>
        </div>
      )}
      <div><SaveTemplateDialog server={server} /></div>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6" data-testid="config-form">
      <SpecForm key={formKey} value={spec} onChange={setSpec} onError={setErrors} mode="server" general={general} contentUi="browser" />
      {stale && dirty && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-torch/40 bg-torch/[0.07] p-2 text-sm text-warn">
          The configuration changed on the server (v{server.specVersion}) and you have unsaved changes.
          <Button type="button" size="sm" variant="secondary" onClick={() => resetTo(server)}>Reload and discard my changes</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-bad">{err}</p>}
      {compatNote && <p role="status" className="text-sm text-warn">{compatNote}</p>}
      {waiting && pending === null && <p role="status" className="text-sm text-muted-foreground">Backing up before applying the change: the panel applies it when the backup succeeds.</p>}
      {jobId && (
        <BackupFirstTracker jobId={jobId} onApplied={() => void onBackupApplied()}
          onFailed={(m) => { setJobId(null); setJobFailed(m); setJobNotice(backupFirstNotice({ state: "failed", message: m }, null)); }} />
      )}
      {save.isSuccess && "specVersion" in save.data && <p role="status" className="text-sm text-ok">Saved (v{save.data.specVersion}). The agent will recreate the container if needed.</p>}
      {jobNotice && (
        <div role={jobNotice.tone === "bad" ? "alert" : "status"} data-testid="backup-first-outcome"
          className={`flex items-start gap-2 rounded-md border p-2 text-sm ${jobNotice.tone === "bad" ? "border-redstone/40 bg-redstone/10 text-bad" : "border-grass/35 bg-grass/10 text-ok"}`}>
          <span className="flex-1">{jobNotice.text}</span>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => setJobNotice(null)}><X /></Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending || waiting || blocked !== null} aria-describedby={blocked ? "cf-apply-why" : undefined}>Review and apply</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => resetTo(server)}>Discard changes</Button>}
        {blocked && <span id="cf-apply-why" className="text-sm text-muted-foreground">{blocked}</span>}
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending && !compatBusy) setPending(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Apply changes to “{base.name}”</DialogTitle>
            <DialogDescription>
              {pending?.recreate
                ? `The container will be recreated${running ? " and the server will restart" : ""} (the world is not touched).`
                : "Only the name changes: the container is not touched."}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-1 overflow-auto text-xs" data-testid="spec-diff">
            {pending?.changes.map((c) => (
              <li key={c.label} className="rounded border border-border p-2">
                <div className="text-muted-foreground">{c.label}</div>
                <div className="break-all font-mono text-bad">- {c.before}</div>
                <div className="break-all font-mono text-ok">+ {c.after}</div>
              </li>
            ))}
          </ul>
          {pending?.spec && compat.checking && <p className="text-xs text-muted-foreground" aria-live="polite">Checking that the content fits this server…</p>}
          {pending?.spec && unavailableNote && <p className="text-xs text-warn" data-testid="compat-unavailable">{unavailableNote}</p>}
          {findings.length > 0 && <CompatBlock findings={findings} version={spec.version} busy={compatBusy || waiting} onUpdate={(f) => void updateCompatible(f)} />}
          {compatError && <p role="alert" className="text-sm text-bad">{compatError}</p>}
          {offer && (
            <div className="flex items-start gap-3 rounded-md border border-cobble bg-bedrock-2/60 p-3" data-testid="backup-first">
              <Checkbox id="cf-backup-first" className="mt-0.5" checked={backupFirst} disabled={waiting || save.isPending} onCheckedChange={(v) => setBackupFirst(v === true)} />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="cf-backup-first">Back up first</Label>
                <p className="text-xs text-muted-foreground">A backup job runs and the change is applied only if it succeeds. {backupReason(base.spec, spec, pack)}</p>
              </div>
            </div>
          )}
          {waiting && <BackupFirstProgress jobId={jobId} />}
          {jobFailed && <p role="alert" className="text-sm text-bad">{jobFailed}. Your changes are still in the form.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>{waiting ? "Close" : "Cancel"}</Button>
            <Button type="button" disabled={save.isPending || waiting || compatBusy} onClick={() => pending && save.mutate(pending)}>
              {save.isPending ? "Applying…" : waiting ? "Waiting for the backup…" : offer && backupFirst ? "Back up and apply" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={blocker.status === "blocked"}
        title={lastLeave.current?.title ?? "Leave"}
        description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Leave"}
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </form>
  );
}

/** Follows the panel's chained job (live through the `jobs` topic) and reports its outcome once. */
function BackupFirstTracker({ jobId, onApplied, onFailed }: { jobId: string; onApplied: () => void; onFailed: (message: string) => void }) {
  useJobsLive();
  const job = useJob(jobId);
  const outcome = backupFirstOutcome(job.data);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || outcome.state === "waiting") return;
    done.current = true;
    if (outcome.state === "applied") onApplied(); else onFailed(outcome.message);
  }, [outcome.state]); // eslint-disable-line react-hooks/exhaustive-deps -- reports the first terminal state only
  return null;
}

function BackupFirstProgress({ jobId }: { jobId: string | null }) {
  const job = useJob(jobId);
  return job.data ? <JobProgress job={job.data} /> : <p className="text-sm text-muted-foreground" aria-live="polite">Starting the backup…</p>;
}

/** Pinned content that will not fit after this change, with the way out. */
function CompatBlock({ findings, version, busy, onUpdate }: { findings: CompatFinding[]; version: string; busy: boolean; onUpdate: (f: CompatFinding[]) => void }) {
  const incompatible = findings.filter((f) => f.problem === "incompatible");
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-torch/40 bg-torch/[0.07] p-3 text-sm text-warn" data-testid="compat-findings">
      <p className="font-medium">{findings.length === 1 ? "1 pinned entry does not fit this server" : `${findings.length} pinned entries do not fit this server`}</p>
      <ul className="list-inside list-disc text-xs">
        {findings.map((f) => (
          <li key={`${f.list}:${f.entry}`}>
            {f.name}: {f.problem === "incompatible" ? `its pinned version does not support Minecraft ${version} with this loader` : `pinned while the server runs ${version}, which changes by itself`}
          </li>
        ))}
      </ul>
      {incompatible.length > 0 && (
        <Button type="button" size="sm" variant="secondary" className="self-start" disabled={busy} onClick={() => onUpdate(incompatible)}>Update to compatible versions</Button>
      )}
      {incompatible.length < findings.length && <p className="text-xs">Pin the Minecraft version to keep pinned content matching.</p>}
    </div>
  );
}
