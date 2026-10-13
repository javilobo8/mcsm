import { useEffect } from "react";
import { RESTART_POLICIES } from "@/lib/spec-catalog";
import { validateMemLimit, validateMemory, type EditableSpec } from "@/lib/spec-edit";
import { Field, NumberField, RequiredSelect, ValidatedInput, type ReportError } from "./fields";

/** "Resources" section: JVM memory, container limits and restart policy. */
export function ResourcesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  // Only the part that depends on memory (the format is validated by the field itself).
  const relError = spec.resources.memLimit && validateMemory(spec.resources.memLimit) === null ? validateMemLimit(spec.resources.memLimit, spec.memory) : null;
  useEffect(() => { onError("sf-memlimit-rel", relError); }, [relError, onError]);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ValidatedInput id="sf-memory" label="JVM memory (MEMORY)" hint="E.g. 4G or 512M." value={spec.memory} onError={onError}
        validate={validateMemory} onChange={(memory) => onChange({ ...spec, memory })} />
      <ValidatedInput id="sf-memlimit" label="Container RAM limit" placeholder="5G" value={spec.resources.memLimit} onError={onError}
        hint="Empty = JVM memory + 1G. If you set it, at least the JVM memory (better +1G)." externalError={relError}
        validate={(v) => (v === "" ? null : validateMemory(v))} onChange={(memLimit) => onChange({ ...spec, resources: { ...spec.resources, memLimit } })} />
      <NumberField id="sf-cpus" label="CPU limit" value={spec.resources.cpus || undefined} min={0} max={256} integer={false} zeroIsEmpty placeholder="2" onError={onError}
        hint="Empty = no limit. Decimals allowed (1.5)." onChange={(cpus) => onChange({ ...spec, resources: { ...spec.resources, cpus: cpus ?? 0 } })} />
      <Field id="sf-restart" label="Restart policy">
        <RequiredSelect id="sf-restart" value={spec.restartPolicy} options={RESTART_POLICIES}
          onChange={(v) => onChange({ ...spec, restartPolicy: v as EditableSpec["restartPolicy"] })} />
      </Field>
    </div>
  );
}
