import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { defaultSpecInput, slugify } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { PAGE, PageHeader } from "@/components/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, ValidatedInput } from "@/components/spec-form/fields";
import { VersionSection } from "@/components/spec-form/version-section";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { applyError, type FormErrors } from "@/lib/form-errors";
import { validateMemory, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { createErrorStep, createRequest, creationSource, parsePort, SCRATCH, stepBlock, summarizeSpec } from "@/lib/wizard";
import { typeLabel } from "@/lib/spec-catalog";
import { cn } from "@/lib/utils";
import { useNodes } from "@/hooks/use-nodes";
import { useTemplates } from "@/hooks/use-templates";

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [{ n: 1, label: "Template or from scratch" }, { n: 2, label: "Node and name" }, { n: 3, label: "Review" }];

/** New server wizard in 3 steps (spec §8). `?template=<id>` opens it at step 2 with that template chosen. */
export function NewServerPage() {
  const { template: preselected } = useSearch({ from: "/app/servers/new" });
  const nodes = useNodes();
  const templates = useTemplates();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(preselected ? 2 : 1);
  const [source, setSource] = useState<string>(preselected ?? SCRATCH);
  const [spec, setSpec] = useState<EditableSpec>(() => ({ ...defaultSpecInput(), type: "PAPER", imageTag: "java21", memory: "4G" }));
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [start, setStart] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const [gone, setGone] = useState(false);
  const onError = useCallback((f: string, m: string | null) => setErrors((p) => applyError(p, f, m)), []);

  const tpl = source === SCRATCH ? undefined : templates.data?.find((t) => t.id === source);

  // A template from the link (or chosen) that no longer exists: warn and choose again.
  const templatesLoaded = templates.isSuccess;
  useEffect(() => {
    if (templatesLoaded && source !== SCRATCH && !tpl) { setGone(true); setSource(SCRATCH); setStep(1); }
  }, [templatesLoaded, source, tpl]);

  const portNum = parsePort(port);
  const selectedNode = nodes.data?.find((n) => n.id === nodeId);
  const online = nodes.data?.filter((n) => n.status === "online") ?? [];
  const ctx = {
    source, templateLoaded: tpl !== undefined, specError: source === SCRATCH ? validateSpec(spec, "server") : null,
    fieldErrors: errors, nodeId, name, port,
  };
  const blocked = step === 3 ? null : stepBlock(step, ctx);

  const create = useMutation({
    mutationFn: () => {
      const from = creationSource(source, tpl, spec);
      if (!from) throw new Error("The chosen template no longer exists: go back to step 1 and choose another");
      const req = createRequest(from, { nodeId, name, port: portNum, start });
      return api.post<ServerDto>(req.url, req.body);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers/$serverId", params: { serverId: s.id } });
    },
    // What was filled in is kept: only the step changes so that the error is seen next to the field.
    onError: (e) => setStep(createErrorStep(e instanceof ApiError ? e.status : undefined)),
  });

  const pick = (id: string) => { setSource(id); setGone(false); };
  const next = () => { if (blocked === null && step < 3) { create.reset(); setStep((step + 1) as Step); } };
  const back = () => { create.reset(); setStep((s) => (s > 1 ? ((s - 1) as Step) : s)); };
  const edited = (set: () => void) => { set(); if (create.isError) create.reset(); };

  const createMsg = create.error?.message ?? null;
  const conflict = create.error instanceof ApiError && create.error.status === 409;
  const portConflict = conflict && /\bports?\b/i.test(createMsg ?? "");
  const summary = tpl ? summarizeSpec(tpl.spec) : source === SCRATCH ? summarizeSpec(spec) : [];

  return (
    <div className={PAGE}>
      <PageHeader title="New server" description="Start from a template or from scratch, pick the node it runs on, and review before creating it." />
      <ol className="flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.n} aria-current={s.n === step ? "step" : undefined} className="flex items-center gap-3">
            {i > 0 && <span aria-hidden="true" className={cn("hidden h-px w-8 sm:block", s.n <= step ? "bg-grass/60" : "bg-cobble-2")} />}
            <span className={cn("flex items-center gap-2", s.n === step ? "font-medium text-bone" : s.n < step ? "text-ok" : "text-muted-foreground")}>
              <span aria-hidden="true" className={cn("notch flex size-6 items-center justify-center text-xs font-semibold [--notch:2px]",
                s.n === step ? "bg-grass text-primary-foreground" : s.n < step ? "bg-grass/15 text-ok" : "bg-bedrock-2 text-muted-foreground")}>
                {s.n < step ? <Check className="size-3.5" /> : s.n}
              </span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      <Card className="max-w-4xl">
        <CardContent className="flex flex-col gap-5">
          {step === 1 && (
            <>
              {gone && <p role="status" className="text-sm text-warn">The link's template no longer exists. Choose another or create the server from scratch.</p>}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Source">
                <SourceCard selected={source === SCRATCH} onSelect={() => pick(SCRATCH)} title="From scratch" subtitle="Choose type, version and mods. The rest is adjusted later in Configuration." />
                {templates.data?.map((t) => (
                  <SourceCard key={t.id} selected={source === t.id} onSelect={() => pick(t.id)} title={t.name}
                    subtitle={`${typeLabel(t.spec.type)} ${t.spec.version} · ${t.spec.memory}${t.description ? ` · ${t.description}` : ""}`} />
                ))}
              </div>
              {templates.isPending && <p className="text-xs text-muted-foreground">Loading templates…</p>}
              {templates.isError && <p role="alert" className="text-xs text-bad">Could not load the templates: {templates.error.message}</p>}
              {source === SCRATCH && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <VersionSection spec={spec} onChange={setSpec} onError={onError} contentUi="browser" />
                  <div className="max-w-xs">
                    <ValidatedInput id="sf-memory" label="JVM memory" hint="E.g. 4G or 512M." value={spec.memory} onError={onError}
                      validate={validateMemory} onChange={(memory) => setSpec({ ...spec, memory })} />
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="ns-node" label="Node">
                <Select value={nodeId} onValueChange={(v) => edited(() => setNodeId(v))}>
                  <SelectTrigger id="ns-node"><SelectValue placeholder={nodes.isPending ? "Loading nodes…" : "Choose a node"} /></SelectTrigger>
                  <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (offline, it will be created when it returns)" : ""}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="ns-name" label="Name" error={conflict && !portConflict ? createMsg : null}
                hint={name.trim() ? <>Folder and container: <code>{slugify(name)}</code> (if it already exists, -2, -3… is added)</> : undefined}>
                <Input id="ns-name" value={name} maxLength={60} placeholder="Survival 2026" aria-invalid={conflict && !portConflict} onChange={(e) => edited(() => setName(e.target.value))} />
              </Field>
              <Field id="ns-port" label="Game port (empty = automatic)" error={portConflict ? createMsg : null}>
                <Input id="ns-port" value={port} inputMode="numeric" placeholder="25565" aria-invalid={portConflict} onChange={(e) => edited(() => setPort(e.target.value))} />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start on creation</label>
              <div className="flex flex-col gap-1 sm:col-span-2">
                {nodes.isError && <p role="alert" className="text-xs text-bad">Could not load the nodes: {nodes.error.message}</p>}
                {selectedNode && selectedNode.status !== "online" && <p className="text-xs text-warn">The node “{selectedNode.name}” is offline: the server will be created but will not start until it returns.</p>}
                {nodes.data && online.length === 0 && <p className="text-xs text-warn">No node is online: the server will be created when the node returns.</p>}
              </div>
            </div>
          )}

          {step === 3 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm" data-testid="wizard-summary">
              <Row label="Source" value={tpl ? `Template “${tpl.name}”` : "From scratch"} />
              {summary.map((l) => <Row key={l.label} label={l.label} value={l.value} />)}
              <Row label="Node" value={selectedNode?.name ?? "—"} />
              <Row label="Name" value={name.trim()} />
              <Row label="Port" value={portNum ? String(portNum) : "automatic"} />
              <Row label="On creation" value={start ? "start" : "leave stopped"} />
            </dl>
          )}

          {create.isError && !conflict && <p role="alert" className="text-sm text-bad">{createMsg}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" disabled={step === 1 || create.isPending} onClick={back}><ArrowLeft className="size-4" /> Back</Button>
            <div className="flex items-center gap-3">
              {blocked && <span id="ns-block-why" className="text-sm text-muted-foreground">{blocked}</span>}
              {step < 3
                ? <Button type="button" disabled={blocked !== null} aria-describedby={blocked ? "ns-block-why" : undefined} onClick={next}>Next <ArrowRight className="size-4" /></Button>
                : <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create server"}</Button>}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="text-bone">{value}</dd></>;
}

function SourceCard({ selected, onSelect, title, subtitle }: { selected: boolean; onSelect: () => void; title: string; subtitle: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn("relative flex cursor-pointer flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors", selected ? "border-grass/70 bg-grass/[0.06]" : "border-cobble bg-deepslate/50 hover:border-cobble-2")}>
      <span className="flex items-center gap-2 font-medium text-bone">
        <span aria-hidden="true" className={cn("size-2", selected ? "bg-grass" : "bg-cobble-2")} />
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}
