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

/** Nodes → Import (spec §8): itzg containers on the node that the panel does not manage yet. */
export function ImportPage() {
  const { nodeId } = useParams({ from: "/app/nodes/$nodeId/import" });
  // Another node = another page: the selection and the review do not carry over from one node to another.
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
          <h1 className="text-xl font-semibold">Import into “{node?.name ?? "…"}”</h1>
          <p className="text-sm text-muted-foreground">itzg/minecraft-server containers on this node that the panel does not manage yet. They are adopted without stopping them.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" asChild><Link to="/nodes">Back to Nodes</Link></Button>
          {!selected && (
            <Button variant="secondary" disabled={q.isFetching} onClick={() => void q.refetch()}>
              {q.isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Search again
            </Button>
          )}
        </div>
      </div>
      {selected
        ? <ImportReview key={selected.containerId} nodeId={nodeId} candidate={selected} onCancel={() => setSelected(null)} />
        : (
          <>
            {q.isPending && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Searching containers…</p>}
            {q.isError && <p role="alert" className="text-sm text-red-400">{q.error.message}</p>}
            {q.data?.length === 0 && <p className="text-sm text-muted-foreground">There are no unmanaged itzg/minecraft-server containers on this node.</p>}
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
          <Button size="sm" disabled={c.blockers.length > 0} onClick={onReview}>Review and import</Button>
        </div>
        <div className="text-sm text-muted-foreground">
          {p.spec.type} {p.spec.version} · {p.spec.memory} · port {p.spec.ports.game ?? "—"} · data <code>{p.dataPath ?? `DATA_ROOT/${p.slug}/data`}</code>
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

  // Unsaved changes: blocks the router navigation (dialog) and warns when closing or reloading the tab.
  // After adopting, navigation to the server page is not blocked.
  const adopted = useRef(false);
  const leave = reviewLeaveWarning(reviewDirty(c, review));
  const guarded = leave !== null;
  const lastLeave = useRef(leave); // the text does not disappear while the dialog closes
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
    // A 504 leaves the server imported (the adoption will complete): the list must show it right away.
    onError: () => { void qc.invalidateQueries({ queryKey: ["servers"] }); },
  });
  const hotBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: false });
  const applyBlock = adoptBlock(c, review, { fieldErrors: errors, specError, applyNow: true });
  const err = adopt.error instanceof ApiError ? adopt.error.message : adopt.error ? "Unexpected error" : null;
  const back = () => { if (guarded) setConfirmBack(true); else onCancel(); };

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="imp-name" label="Name"><Input id="imp-name" value={review.name} maxLength={60} onChange={(e) => setReview((r) => ({ ...r, name: e.target.value }))} /></Field>
      <Field id="imp-slug" label="Slug" hint={c.proposal.slugLocked ? `Fixed: the data is already in DATA_ROOT/${c.proposal.slug}/data.` : `The managed container will be called mcsm-${review.slug}.`}>
        <Input id="imp-slug" className="font-mono" value={review.slug} maxLength={40} disabled={c.proposal.slugLocked} onChange={(e) => setReview((r) => ({ ...r, slug: e.target.value }))} />
      </Field>
      <div className="text-sm text-muted-foreground">
        Data: <code>{c.proposal.dataPath ?? `DATA_ROOT/${review.slug}/data`}</code> · {c.proposal.desiredState === "running" ? "running" : "stopped"}
      </div>
      {c.hiddenEnv.length > 0 && <p className="text-xs text-muted-foreground">Not shown (secrets): {c.hiddenEnv.join(", ")}. RCON_PASSWORD is kept as the RCON password.</p>}
    </div>
  );

  return (
    <div className="flex max-w-5xl flex-col gap-4" data-testid="import-review">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Review “{c.containerName}”</h2>
        <Button variant="ghost" disabled={adopt.isPending} onClick={back}>Back to the list</Button>
      </div>
      {c.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-900 bg-amber-950/30 p-2 text-sm text-amber-300">
          {c.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</li>)}
        </ul>
      )}
      {c.proposal.specError && <p role="alert" className="text-sm text-red-400">The deduced configuration is not valid as is ({c.proposal.specError}): fix it and use “Adopt and apply”.</p>}
      <SpecForm value={review.spec} onChange={(spec) => setReview((r) => ({ ...r, spec }))} onError={setErrors} mode="server" general={general}
        routerHidden={IMPORT_ROUTER_NOTE} />
      {err && !confirmApply && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={adopt.isPending || hotBlock !== null} aria-describedby={hotBlock ? "imp-hot-why" : undefined} onClick={() => adopt.mutate(false)}>
          {adopt.isPending && !confirmApply ? "Adopting…" : "Adopt without stopping"}
        </Button>
        <Button variant="secondary" disabled={adopt.isPending || applyBlock !== null} onClick={() => { adopt.reset(); setConfirmApply(true); }}>Adopt and apply now</Button>
        {hotBlock
          ? <span id="imp-hot-why" className="text-sm text-muted-foreground">{hotBlock}</span>
          : isPristine(c, review.spec) && <span className="text-sm text-muted-foreground">The container keeps running; it will be recreated with the first “Save and apply”.</span>}
      </div>
      <ConfirmDialog
        open={confirmApply}
        title={`Adopt and apply “${review.name.trim() || c.containerName}”`}
        description={`The container is adopted and immediately recreated as mcsm-${review.slug} with this configuration: the server stops for a moment and the original container is deleted (the world is not touched).`}
        confirmLabel="Adopt and apply"
        pending={adopt.isPending}
        error={confirmApply ? err : null}
        onConfirm={() => adopt.mutate(true)}
        onCancel={() => setConfirmApply(false)}
      />
      <ConfirmDialog
        open={confirmBack || blocker.status === "blocked"}
        title={lastLeave.current?.title ?? "Leave"}
        description={lastLeave.current?.description ?? ""}
        confirmLabel={lastLeave.current?.confirmLabel ?? "Leave"}
        cancelLabel="Stay"
        onConfirm={() => { if (confirmBack) { setConfirmBack(false); onCancel(); } else blocker.proceed?.(); }}
        onCancel={() => { if (confirmBack) setConfirmBack(false); else blocker.reset?.(); }}
      />
    </div>
  );
}
