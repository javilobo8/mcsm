import { useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Loader2, RefreshCw } from "lucide-react";
import type { ImportCandidateDto } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SpecForm, type SpecFormErrors } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { useNodes } from "@/hooks/use-nodes";
import { useImportCandidates } from "@/hooks/use-import";
import { api, apiPath, ApiError, type ServerDto } from "@/lib/api";
import { validateSpec } from "@/lib/spec-edit";
import {
  IMPORT_ROUTER_NOTE, adoptBlock, adoptRequest, candidateStateLabel, initialReview, isPristine, reviewDirty, reviewLeaveWarning, type ReviewState,
} from "@/lib/import";

/** Nodos → Importar (spec §8): contenedores itzg del nodo que el panel aún no gestiona. */
export function ImportPage() {
  const { nodeId } = useParams({ from: "/app/nodes/$nodeId/import" });
  // Otro nodo = otra página: la selección y la revisión no pasan de un nodo a otro.
  return <NodeImport key={nodeId} nodeId={nodeId} />;
}

function NodeImport({ nodeId }: { nodeId: string }) {
  const nodes = useNodes();
  const node = nodes.data?.find((n) => n.id === nodeId);
  const q = useImportCandidates(nodeId);
  const [selected, setSelected] = useState<ImportCandidateDto | null>(null);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Importar en «{node?.name ?? "…"}»</h1>
          <p className="text-sm text-muted-foreground">Contenedores de itzg/minecraft-server de este nodo que el panel aún no gestiona. Se adoptan sin pararlos.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" asChild><Link to="/nodes">Volver a Nodos</Link></Button>
          {!selected && (
            <Button variant="secondary" disabled={q.isFetching} onClick={() => void q.refetch()}>
              {q.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Volver a buscar
            </Button>
          )}
        </div>
      </div>
      {selected
        ? <ImportReview key={selected.containerId} nodeId={nodeId} candidate={selected} onCancel={() => setSelected(null)} />
        : (
          <>
            {q.isPending && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Buscando contenedores…</p>}
            {q.isError && <p role="alert" className="text-sm text-red-400">{q.error.message}</p>}
            {q.data?.length === 0 && <p className="text-sm text-muted-foreground">No hay contenedores de itzg/minecraft-server sin gestionar en este nodo.</p>}
            <div className="grid gap-3 lg:grid-cols-2">{q.data?.map((c) => <CandidateCard key={c.containerId} c={c} onReview={() => setSelected(c)} />)}</div>
          </>
        )}
    </div>
  );
}

function CandidateCard({ c, onReview }: { c: ImportCandidateDto; onReview: () => void }) {
  const p = c.proposal;
  return (
    <Card data-testid="import-candidate">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">{c.containerName}</div>
            <div className="text-xs text-muted-foreground">
              <code>{c.image}</code> · {candidateStateLabel(c.state)}{c.composeProject ? ` · compose ${c.composeProject}/${c.composeService}` : ""}
            </div>
          </div>
          <Button size="sm" disabled={c.blockers.length > 0} onClick={onReview}>Revisar e importar</Button>
        </div>
        <div className="text-sm text-muted-foreground">
          {p.spec.type} {p.spec.version} · {p.spec.memory} · puerto {p.spec.ports.game ?? "—"} · datos <code>{p.dataPath ?? `DATA_ROOT/${p.slug}/data`}</code>
        </div>
        {c.blockers.map((b) => <p key={b} className="flex gap-2 text-sm text-red-400"><Ban className="mt-0.5 size-4 shrink-0" />{b}</p>)}
        {c.warnings.map((w) => <p key={w} className="flex gap-2 text-sm text-amber-400"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}
      </CardContent>
    </Card>
  );
}

function ImportReview({ nodeId, candidate: c, onCancel }: { nodeId: string; candidate: ImportCandidateDto; onCancel: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [review, setReview] = useState<ReviewState>(() => initialReview(c));
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const specError = validateSpec(review.spec, "server");

  // Cambios sin guardar: bloquea la navegación del router (diálogo) y avisa al cerrar o recargar la pestaña.
  // Tras adoptar no se bloquea la navegación a la página del servidor.
  const adopted = useRef(false);
  const leave = reviewLeaveWarning(reviewDirty(c, review));
  const guarded = leave !== null;
  const lastLeave = useRef(leave); // el texto no desaparece mientras se cierra el diálogo
  if (leave) lastLeave.current = leave;
  const blocker = useBlocker({ shouldBlockFn: () => !adopted.current, disabled: !guarded, enableBeforeUnload: () => guarded && !adopted.current, withResolver: true });

  const adopt = useMutation({
    mutationFn: (applyNow: boolean) => api.post<ServerDto>(apiPath`/api/nodes/${nodeId}/import`, adoptRequest(c, review, applyNow)),
    onSuccess: (dto) => {
      adopted.current = true;
      setConfirmApply(false);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["import-candidates", nodeId] });
      void navigate({ to: "/servers/$serverId", params: { serverId: dto.id } });
    },
    // Un 504 deja el servidor importado (la adopción se completará): el listado debe enseñarlo ya.
    onError: () => { void qc.invalidateQueries({ queryKey: ["servers"] }); },
  });
  const hotBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: false });
  const applyBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: true });
  const err = adopt.error instanceof ApiError ? adopt.error.message : adopt.error ? "Error inesperado" : null;
  const back = () => { if (guarded) setConfirmBack(true); else onCancel(); };

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="imp-name" label="Nombre"><Input id="imp-name" value={review.name} maxLength={60} onChange={(e) => setReview((r) => ({ ...r, name: e.target.value }))} /></Field>
      <Field id="imp-slug" label="Slug" hint={c.proposal.slugLocked ? `Fijo: los datos ya están en DATA_ROOT/${c.proposal.slug}/data.` : `El contenedor gestionado se llamará mcsm-${review.slug}.`}>
        <Input id="imp-slug" className="font-mono" value={review.slug} maxLength={40} disabled={c.proposal.slugLocked} onChange={(e) => setReview((r) => ({ ...r, slug: e.target.value }))} />
      </Field>
      <div className="text-sm text-muted-foreground">
        Datos: <code>{c.proposal.dataPath ?? `DATA_ROOT/${review.slug}/data`}</code> · {c.proposal.desiredState === "running" ? "en marcha" : "parado"}
      </div>
      {c.hiddenEnv.length > 0 && <p className="text-xs text-muted-foreground">No se muestran (secretos): {c.hiddenEnv.join(", ")}. RCON_PASSWORD se conserva como contraseña RCON.</p>}
    </div>
  );

  return (
    <div className="flex max-w-5xl flex-col gap-4" data-testid="import-review">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Revisar «{c.containerName}»</h2>
        <Button variant="ghost" disabled={adopt.isPending} onClick={back}>Volver a la lista</Button>
      </div>
      {c.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-300">
          {c.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</li>)}
        </ul>
      )}
      {c.proposal.specError && <p role="alert" className="text-sm text-red-400">La configuración deducida no es válida tal cual ({c.proposal.specError}): corrígela y usa «Adoptar y aplicar».</p>}
      <SpecForm value={review.spec} onChange={(spec) => setReview((r) => ({ ...r, spec }))} onError={setErrors} mode="server" general={general}
        routerHidden={IMPORT_ROUTER_NOTE} />
      {err && !confirmApply && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={adopt.isPending || hotBlock !== null} aria-describedby={hotBlock ? "imp-hot-why" : undefined} onClick={() => adopt.mutate(false)}>
          {adopt.isPending && !confirmApply ? "Adoptando…" : "Adoptar sin parar"}
        </Button>
        <Button variant="secondary" disabled={adopt.isPending || applyBlock !== null} onClick={() => { adopt.reset(); setConfirmApply(true); }}>Adoptar y aplicar ahora</Button>
        {hotBlock
          ? <span id="imp-hot-why" className="text-sm text-muted-foreground">{hotBlock}</span>
          : isPristine(c, review.spec) && <span className="text-sm text-muted-foreground">El contenedor sigue en marcha; se recreará con el primer «Guardar y aplicar».</span>}
      </div>
      <ConfirmDialog
        open={confirmApply}
        title={`Adoptar y aplicar «${review.name.trim() || c.containerName}»`}
        description={`Se adopta el contenedor y enseguida se recrea como mcsm-${review.slug} con esta configuración: el servidor se para un momento y el contenedor original se borra (el mundo no se toca).`}
        confirmLabel="Adoptar y aplicar"
        pending={adopt.isPending}
        error={confirmApply ? err : null}
        onConfirm={() => adopt.mutate(true)}
        onCancel={() => setConfirmApply(false)}
      />
      <ConfirmDialog
        open={confirmBack || blocker.status === "blocked"}
        title={lastLeave.current?.title ?? "Salir"}
        description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Salir"}
        cancelLabel="Quedarme"
        onConfirm={() => { if (confirmBack) { setConfirmBack(false); onCancel(); } else blocker.proceed?.(); }}
        onCancel={() => { if (confirmBack) setConfirmBack(false); else blocker.reset?.(); }}
      />
    </div>
  );
}
