import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { defaultSpecInput } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SpecForm, type SpecFormErrors } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { api, apiPath, ApiError, type TemplateDto } from "@/lib/api";
import { editableFromTemplate, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { templateCreateBody, templatePatchBody, templateSaveBlock } from "@/lib/template-edit";
import { useTemplate } from "@/hooks/use-templates";

function TemplateEditor({ template }: { template?: TemplateDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [spec, setSpec] = useState<EditableSpec>(() => (template ? editableFromTemplate(template.spec) : { ...defaultSpecInput(), ports: { extra: [] } }));
  const [errors, setErrors] = useState<SpecFormErrors>({});
  const [localErr, setLocalErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => template
      ? api.patch<TemplateDto>(apiPath`/api/templates/${template.id}`, templatePatchBody(editableFromTemplate(template.spec), spec, name, description))
      : api.post<TemplateDto>("/api/templates", templateCreateBody(name, description, spec)),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["templates"] });
      qc.setQueryData(["template", t.id], t);
      void navigate({ to: "/templates" });
    },
  });

  const blocked = templateSaveBlock(name, errors);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    if (blocked) return setLocalErr(blocked);
    const invalid = validateSpec(spec, "template");
    if (invalid) return setLocalErr(invalid);
    save.mutate();
  };

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="tpl-name" label="Nombre de la plantilla"><Input id="tpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="tpl-desc" label="Descripción (opcional)"><Textarea id="tpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Las plantillas no guardan puertos ni contraseña RCON: el panel los asigna al crear cada servidor.</p>
    </div>
  );
  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Error inesperado" : null);

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{template ? `Plantilla «${template.name}»` : "Nueva plantilla"}</h1>
        <Button asChild variant="ghost"><Link to="/templates">Volver</Link></Button>
      </div>
      <SpecForm value={spec} onChange={setSpec} onError={setErrors} mode="template" general={general} />
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending || blocked !== null} aria-describedby={blocked ? "tpl-save-why" : undefined}>
          {save.isPending ? "Guardando…" : template ? "Guardar cambios" : "Crear plantilla"}
        </Button>
        {blocked && <span id="tpl-save-why" className="text-sm text-muted-foreground">{blocked}</span>}
      </div>
    </form>
  );
}

export function NewTemplatePage() {
  return <TemplateEditor />;
}

export function EditTemplatePage() {
  const { templateId } = useParams({ from: "/app/templates/$templateId" });
  const q = useTemplate(templateId);
  if (q.isPending) return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cargando…</div>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <div role="alert" className="p-6 text-red-400">{notFound ? "Plantilla no encontrada" : `No se pudo cargar la plantilla: ${q.error.message}`}</div>;
  }
  return <TemplateEditor key={q.data.id} template={q.data} />;
}
