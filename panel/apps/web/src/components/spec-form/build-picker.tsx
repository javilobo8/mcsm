import { useState } from "react";
import { useBuilds } from "@/hooks/use-versions";
import { buildLabel, buildOptions, buildUnavailableReason, hasUnstableBuilds } from "@/lib/versions";
import { Field, OptionalSelect } from "./fields";

/** Build o versión del loader (vacío = el último al arrancar). Solo para los tipos que lo admiten (plan 10). */
export function BuildPicker({ type, version, value, onChange }: { type: string; version: string; value: string; onChange: (v: string) => void }) {
  const label = buildLabel(type);
  const unavailable = buildUnavailableReason(version);
  const concrete = unavailable === null;
  const [showUnstable, setShowUnstable] = useState(false);
  const builds = useBuilds(type, version, label !== null && concrete);
  if (label === null) return null;
  const list = builds.data?.builds ?? [];
  const hint = unavailable !== null ? unavailable
    : builds.isPending ? "Cargando builds…"
    : builds.isError ? `${builds.error.message}. Se usará el último.`
    : list.length === 0 ? "La fuente no publica builds estables para esta versión: se usará el último."
    : "Vacío = el último al arrancar.";
  return (
    <div className="flex flex-col gap-1">
      <Field id="sf-build" label={label} hint={hint}>
        <OptionalSelect id="sf-build" value={value || undefined} defaultLabel="(el último)"
          options={concrete ? buildOptions(list, value, showUnstable) : []} onChange={(v) => onChange(v ?? "")} />
      </Field>
      {concrete && hasUnstableBuilds(type) && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showUnstable} onChange={(e) => setShowUnstable(e.target.checked)} /> Mostrar betas
        </label>
      )}
    </div>
  );
}
