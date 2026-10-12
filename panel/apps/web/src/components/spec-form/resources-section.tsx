import { useEffect } from "react";
import { RESTART_POLICIES } from "@/lib/spec-catalog";
import { validateMemLimit, validateMemory, type EditableSpec } from "@/lib/spec-edit";
import { Field, NumberField, RequiredSelect, ValidatedInput, type ReportError } from "./fields";

/** Sección "Recursos": memoria de la JVM, límites del contenedor y política de reinicio. */
export function ResourcesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  // Solo la parte que depende de la memoria (el formato lo valida el propio campo).
  const relError = spec.resources.memLimit && validateMemory(spec.resources.memLimit) === null ? validateMemLimit(spec.resources.memLimit, spec.memory) : null;
  useEffect(() => { onError("sf-memlimit-rel", relError); }, [relError, onError]);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ValidatedInput id="sf-memory" label="Memoria de la JVM (MEMORY)" hint="Ej. 4G o 512M." value={spec.memory} onError={onError}
        validate={validateMemory} onChange={(memory) => onChange({ ...spec, memory })} />
      <ValidatedInput id="sf-memlimit" label="Límite de RAM del contenedor" placeholder="5G" value={spec.resources.memLimit} onError={onError}
        hint="Vacío = sin límite. Si lo pones, al menos la memoria de la JVM (mejor +1G)." externalError={relError}
        validate={(v) => (v === "" ? null : validateMemory(v))} onChange={(memLimit) => onChange({ ...spec, resources: { ...spec.resources, memLimit } })} />
      <NumberField id="sf-cpus" label="Límite de CPUs" value={spec.resources.cpus || undefined} min={0} max={256} integer={false} placeholder="2" onError={onError}
        hint="Vacío = sin límite. Admite decimales (1.5)." onChange={(cpus) => onChange({ ...spec, resources: { ...spec.resources, cpus: cpus ?? 0 } })} />
      <Field id="sf-restart" label="Política de reinicio">
        <RequiredSelect id="sf-restart" value={spec.restartPolicy} options={RESTART_POLICIES}
          onChange={(v) => onChange({ ...spec, restartPolicy: v as EditableSpec["restartPolicy"] })} />
      </Field>
    </div>
  );
}
