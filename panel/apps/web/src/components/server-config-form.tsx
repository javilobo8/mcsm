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

/** Pestaña Configuración: formulario por secciones, diff antes de aplicar y PATCH mínimo (merge). */
export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [spec, setSpec] = useState<EditableSpec>(() => toEditable(server));
  // Línea base: lo cargado en el formulario y su versión (para detectar cambios hechos fuera).
  const [base, setBase] = useState(() => ({ version: server.specVersion, name: server.name, spec: toEditable(server) }));
  const [formKey, setFormKey] = useState(0); // remonta los campos (que guardan texto local) al recargar
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
  // Solo al cambiar stale/dirty: resetTo y server se leen frescos del render en que cambian (no son dependencias a propósito).
  useEffect(() => { if (stale && !dirty) resetTo(server); }, [stale, dirty]); // eslint-disable-line react-hooks/exhaustive-deps -- ver arriba

  // Cambios sin guardar: bloquea la navegación del router (diálogo), el cambio de pestaña del servidor y avisa al
  // cerrar o recargar la pestaña del navegador, como el editor de Archivos.
  const leave = configLeaveWarning(dirty);
  const guarded = leave !== null;
  const lastLeave = useRef(leave); // el texto no desaparece mientras se cierra el diálogo
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

  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Error inesperado" : null);
  const running = server.desiredState === "running";

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="cf-name" label="Nombre"><Input id="cf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="text-sm text-muted-foreground">Slug <code className="rounded bg-muted px-1">{server.slug}</code> · contenedor <code className="rounded bg-muted px-1">{`mcsm-${server.slug}`}</code></div>
      {server.spec.rconPassword && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Contraseña RCON:</span>
          <code className="rounded bg-muted px-1.5 py-0.5" data-testid="rcon">{showRcon ? server.spec.rconPassword : "••••••••••••"}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowRcon((s) => !s)} aria-pressed={showRcon}>
            {showRcon ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{showRcon ? "Ocultar" : "Revelar"}
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
          La configuración cambió en el servidor (v{server.specVersion}) y tienes cambios sin guardar.
          <Button type="button" size="sm" variant="secondary" onClick={() => resetTo(server)}>Recargar y descartar mis cambios</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Guardado (v{save.data.specVersion}). El agente recreará el contenedor si hace falta.</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending || blocked !== null} aria-describedby={blocked ? "cf-apply-why" : undefined}>Revisar y aplicar</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => resetTo(server)}>Descartar cambios</Button>}
        {blocked && <span id="cf-apply-why" className="text-sm text-muted-foreground">{blocked}</span>}
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Aplicar cambios en «{base.name}»</DialogTitle>
            <DialogDescription>
              {pending?.recreate
                ? `El contenedor se recreará${running ? " y el servidor se reiniciará" : ""} (el mundo no se toca).`
                : "Solo cambia el nombre: el contenedor no se toca."}
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
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>Cancelar</Button>
            <Button type="button" disabled={save.isPending} onClick={() => pending && save.mutate(pending)}>{save.isPending ? "Aplicando…" : "Aplicar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={blocker.status === "blocked"}
        title={lastLeave.current?.title ?? "Salir"}
        description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Salir"}
        cancelLabel="Quedarme"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </form>
  );
}
