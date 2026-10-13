import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { canonicalJson } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SpecForm, type SpecFormErrors } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { SaveTemplateDialog } from "@/components/save-template-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useTabGuard } from "@/components/guarded-tabs";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";
import { editableSpec, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { configLeaveWarning, isStale, planApply, type PendingApply } from "@/lib/config-apply";
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

  const save = useMutation({
    mutationFn: (p: PendingApply) => api.patch<ServerDto>(apiPath`/api/servers/${server.id}`, { ...(p.name ? { name: p.name } : {}), ...(p.spec ? { spec: p.spec } : {}) }),
    onSuccess: (dto) => {
      setPending(null);
      resetTo(dto);
      qc.setQueryData(["server", server.id], dto);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: () => setPending(null),
  });

  const blocked = templateSaveBlock(name, errors);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    if (blocked) return setLocalErr(blocked);
    const invalid = validateSpec(spec, "server");
    if (invalid) return setLocalErr(invalid);
    const plan = planApply(base.name, base.spec, name, spec);
    if (!plan.ok) return setLocalErr(plan.error);
    setPending(plan.pending);
  };

  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Unexpected error" : null);
  const running = server.desiredState === "running";

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
      <div><SaveTemplateDialog server={server} /></div>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6" data-testid="config-form">
      <SpecForm key={formKey} value={spec} onChange={setSpec} onError={setErrors} mode="server" general={general} />
      {stale && dirty && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700 bg-amber-950/30 p-2 text-sm text-amber-300">
          The configuration changed on the server (v{server.specVersion}) and you have unsaved changes.
          <Button type="button" size="sm" variant="secondary" onClick={() => resetTo(server)}>Reload and discard my changes</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Saved (v{save.data.specVersion}). The agent will recreate the container if needed.</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending || blocked !== null} aria-describedby={blocked ? "cf-apply-why" : undefined}>Review and apply</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => resetTo(server)}>Discard changes</Button>}
        {blocked && <span id="cf-apply-why" className="text-sm text-muted-foreground">{blocked}</span>}
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <DialogContent className="max-w-2xl">
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
                <div className="break-all font-mono text-red-300">- {c.before}</div>
                <div className="break-all font-mono text-emerald-300">+ {c.after}</div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>Cancel</Button>
            <Button type="button" disabled={save.isPending} onClick={() => pending && save.mutate(pending)}>{save.isPending ? "Applying…" : "Apply"}</Button>
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
