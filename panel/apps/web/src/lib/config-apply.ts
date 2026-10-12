import type { SpecPatch } from "@mcsm/shared";
import { mergeSpecPatch } from "@mcsm/shared";
import { buildSpecPatch, type EditableSpec } from "./spec-edit";
import { diffSpecs, type DiffLine } from "./spec-diff";

/** Cambios pendientes de confirmar: cuerpo mínimo del PATCH, diff legible y si el contenedor se recrea. */
export interface PendingApply { name?: string; spec?: SpecPatch; changes: DiffLine[]; recreate: boolean }

export type ApplyPlan = { ok: true; pending: PendingApply } | { ok: false; error: string };

/**
 * Prepara «Aplicar»: PATCH mínimo (merge de primer nivel), y un diff entre lo guardado y lo que quedará tras el
 * merge del panel. Cualquier cambio de spec recrea el contenedor; solo el nombre no.
 */
export function planApply(baseName: string, baseSpec: EditableSpec, name: string, edited: EditableSpec): ApplyPlan {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "El nombre no puede estar vacío" };
  // Puerto de juego vacío al editar = el panel conserva el actual (completeSpec): ni «N → —» ni PATCH de ports.
  const spec = edited.ports.game === undefined && baseSpec.ports.game !== undefined
    ? { ...edited, ports: { ...edited.ports, game: baseSpec.ports.game } }
    : edited;
  const patch = buildSpecPatch(baseSpec, spec);
  const hasSpec = Object.keys(patch).length > 0;
  const changes = hasSpec ? diffSpecs(baseSpec, mergeSpecPatch(baseSpec, patch)) : [];
  const renamed = trimmed !== baseName;
  if (renamed) changes.unshift({ label: "Nombre", before: baseName, after: trimmed });
  if (!renamed && !hasSpec) return { ok: false, error: "No hay cambios que aplicar" };
  return { ok: true, pending: { name: renamed ? trimmed : undefined, spec: hasSpec ? patch : undefined, changes, recreate: hasSpec } };
}
