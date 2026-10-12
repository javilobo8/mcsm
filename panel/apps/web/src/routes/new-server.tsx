import { useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { defaultSpecInput, slugify } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, ValidatedInput } from "@/components/spec-form/fields";
import { VersionSection } from "@/components/spec-form/version-section";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { applyError, type FormErrors } from "@/lib/form-errors";
import { validateMemory, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { createErrorStep, createRequest, parsePort, SCRATCH, stepBlock, summarizeSpec } from "@/lib/wizard";
import { typeLabel } from "@/lib/spec-catalog";
import { cn } from "@/lib/utils";
import { useNodes } from "@/hooks/use-nodes";
import { useTemplates } from "@/hooks/use-templates";

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [{ n: 1, label: "Plantilla o desde cero" }, { n: 2, label: "Nodo y nombre" }, { n: 3, label: "Revisar" }];

/** Asistente de nuevo servidor en 3 pasos (spec §8). `?template=<id>` lo abre en el paso 2 con esa plantilla elegida. */
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

  // Una plantilla del enlace (o elegida) que ya no existe: avisa y vuelve a elegir.
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
      const req = createRequest(tpl ? { templateId: tpl.id } : { spec }, { nodeId, name, port: portNum, start });
      return api.post<ServerDto>(req.url, req.body);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers/$serverId", params: { serverId: s.id } });
    },
    // Lo rellenado se conserva: solo se cambia de paso para que el error se vea junto al campo.
    onError: (e) => setStep(createErrorStep(e instanceof ApiError ? e.status : undefined)),
  });

  const pick = (id: string) => { setSource(id); setGone(false); };
  const next = () => { if (blocked === null && step < 3) { create.reset(); setStep((step + 1) as Step); } };
  const back = () => { create.reset(); setStep((s) => (s > 1 ? ((s - 1) as Step) : s)); };
  const edited = (set: () => void) => { set(); if (create.isError) create.reset(); };

  const createMsg = create.error?.message ?? null;
  const conflict = create.error instanceof ApiError && create.error.status === 409;
  const portConflict = conflict && /puerto/i.test(createMsg ?? "");
  const summary = tpl ? summarizeSpec(tpl.spec) : source === SCRATCH ? summarizeSpec(spec) : [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Pasos">
        {STEPS.map((s) => (
          <li key={s.n} aria-current={s.n === step ? "step" : undefined}
            className={cn("rounded-full border px-3 py-1", s.n === step ? "border-ring bg-accent" : s.n < step ? "border-emerald-800 text-emerald-400" : "border-border text-muted-foreground")}>
            {s.n < step ? <Check className="mr-1 inline size-3" /> : `${s.n}. `}{s.label}
          </li>
        ))}
      </ol>

      <Card className="max-w-4xl">
        <CardHeader><CardTitle>Nuevo servidor</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-5">
          {step === 1 && (
            <>
              {gone && <p role="status" className="text-sm text-amber-400">La plantilla del enlace ya no existe. Elige otra o crea el servidor desde cero.</p>}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Origen">
                <SourceCard selected={source === SCRATCH} onSelect={() => pick(SCRATCH)} title="Desde cero" subtitle="Elige tipo, versión y mods. El resto se ajusta después en Configuración." />
                {templates.data?.map((t) => (
                  <SourceCard key={t.id} selected={source === t.id} onSelect={() => pick(t.id)} title={t.name}
                    subtitle={`${typeLabel(t.spec.type)} ${t.spec.version} · ${t.spec.memory}${t.description ? ` · ${t.description}` : ""}`} />
                ))}
              </div>
              {templates.isPending && <p className="text-xs text-muted-foreground">Cargando plantillas…</p>}
              {templates.isError && <p role="alert" className="text-xs text-red-400">No se pudieron cargar las plantillas: {templates.error.message}</p>}
              {source === SCRATCH && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <VersionSection spec={spec} onChange={setSpec} onError={onError} />
                  <div className="max-w-xs">
                    <ValidatedInput id="sf-memory" label="Memoria de la JVM" hint="Ej. 4G o 512M." value={spec.memory} onError={onError}
                      validate={validateMemory} onChange={(memory) => setSpec({ ...spec, memory })} />
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="ns-node" label="Nodo">
                <Select value={nodeId} onValueChange={(v) => edited(() => setNodeId(v))}>
                  <SelectTrigger id="ns-node"><SelectValue placeholder={nodes.isPending ? "Cargando nodos…" : "Elige un nodo"} /></SelectTrigger>
                  <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (desconectado, se creará al volver)" : ""}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field id="ns-name" label="Nombre" error={conflict && !portConflict ? createMsg : null}
                hint={name.trim() ? <>Carpeta y contenedor: <code>{slugify(name)}</code> (si ya existe se añade -2, -3…)</> : undefined}>
                <Input id="ns-name" value={name} maxLength={60} placeholder="Supervivencia 2026" aria-invalid={conflict && !portConflict} onChange={(e) => edited(() => setName(e.target.value))} />
              </Field>
              <Field id="ns-port" label="Puerto de juego (vacío = automático)" error={portConflict ? createMsg : null}>
                <Input id="ns-port" value={port} inputMode="numeric" placeholder="25565" aria-invalid={portConflict} onChange={(e) => edited(() => setPort(e.target.value))} />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Arrancar al crear</label>
              <div className="flex flex-col gap-1 sm:col-span-2">
                {nodes.isError && <p role="alert" className="text-xs text-red-400">No se pudieron cargar los nodos: {nodes.error.message}</p>}
                {selectedNode && selectedNode.status !== "online" && <p className="text-xs text-amber-400">El nodo «{selectedNode.name}» está desconectado: el servidor se creará pero no arrancará hasta que vuelva.</p>}
                {nodes.data && online.length === 0 && <p className="text-xs text-amber-400">Ningún nodo conectado: el servidor se creará cuando el nodo vuelva.</p>}
              </div>
            </div>
          )}

          {step === 3 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm" data-testid="wizard-summary">
              <Row label="Origen" value={tpl ? `Plantilla «${tpl.name}»` : "Desde cero"} />
              {summary.map((l) => <Row key={l.label} label={l.label} value={l.value} />)}
              <Row label="Nodo" value={selectedNode?.name ?? "—"} />
              <Row label="Nombre" value={name.trim()} />
              <Row label="Puerto" value={portNum ? String(portNum) : "automático"} />
              <Row label="Al crear" value={start ? "arrancar" : "dejar parado"} />
            </dl>
          )}

          {create.isError && !conflict && <p role="alert" className="text-sm text-red-400">{createMsg}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" disabled={step === 1 || create.isPending} onClick={back}><ArrowLeft className="size-4" /> Atrás</Button>
            <div className="flex items-center gap-3">
              {blocked && <span id="ns-block-why" className="text-sm text-muted-foreground">{blocked}</span>}
              {step < 3
                ? <Button type="button" disabled={blocked !== null} aria-describedby={blocked ? "ns-block-why" : undefined} onClick={next}>Siguiente <ArrowRight className="size-4" /></Button>
                : <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creando…" : "Crear servidor"}</Button>}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></>;
}

function SourceCard({ selected, onSelect, title, subtitle }: { selected: boolean; onSelect: () => void; title: string; subtitle: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn("flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm hover:border-ring", selected ? "border-ring bg-accent" : "border-border")}>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}
