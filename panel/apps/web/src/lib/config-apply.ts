import type { SpecPatch } from "@mcsm/shared";
import { mergeSpecPatch } from "@mcsm/shared";
import { buildSpecPatch, type EditableSpec } from "./spec-edit";
import { diffSpecs, type DiffLine } from "./spec-diff";
import type { GuardText } from "./tab-guard";

/** Cambios pendientes de confirmar: cuerpo mínimo del PATCH, diff legible y si el contenedor se recrea. */
export interface PendingApply { name?: string; spec?: SpecPatch; changes: DiffLine[]; recreate: boolean }

export type ApplyPlan = { ok: true; pending: PendingApply } | { ok: false; error: string };

/**
 * Prepara «Aplicar»: PATCH mínimo (merge de primer nivel), y un diff entre lo guardado y lo que quedará tras el
 * merge del panel. Cualquier cambio de spec recrea el contenedor; solo el nombre no. Si el diff de la spec queda
 * vacío no se envía ni se promete recreación: solo se aplica lo que el diálogo enseña.
 */
export function planApply(baseName: string, baseSpec: EditableSpec, name: string, edited: EditableSpec): ApplyPlan {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "El nombre no puede estar vacío" };
  // Puerto de juego vacío al editar = el panel conserva el actual (completeSpec): ni «N → —» ni PATCH de ports.
  const spec = edited.ports.game === undefined && baseSpec.ports.game !== undefined
    ? { ...edited, ports: { ...edited.ports, game: baseSpec.ports.game } }
    : edited;
  const patch = buildSpecPatch(baseSpec, spec);
  const changes = Object.keys(patch).length > 0 ? diffSpecs(baseSpec, mergeSpecPatch(baseSpec, patch)) : [];
  const hasSpec = changes.length > 0;
  const renamed = trimmed !== baseName;
  if (renamed) changes.unshift({ label: "Nombre", before: baseName, after: trimmed });
  if (!renamed && !hasSpec) return { ok: false, error: "No hay cambios que aplicar" };
  return { ok: true, pending: { name: renamed ? trimmed : undefined, spec: hasSpec ? patch : undefined, changes, recreate: hasSpec } };
}

/**
 * ¿Cambió la configuración fuera del formulario? Solo si el servidor va POR DELANTE de la base: justo tras
 * aplicar, la base ya es N+1 y la prop `server` sigue en N hasta que llega el setQueryData; con «!==» se
 * recargaba la versión vieja (parpadeo y doble remonte).
 */
export function isStale(serverVersion: number, baseVersion: number): boolean {
  return serverVersion > baseVersion;
}

const CONFIG_LEAVE_WARNING: GuardText = {
  title: "Cambios sin guardar",
  description: "Hay cambios sin guardar en la configuración. Si sales, se perderán.",
  confirmLabel: "Salir y descartar",
};

/**
 * Qué proteger al salir de la pestaña Configuración (otra pestaña, otra página o cerrar el navegador): sus
 * cambios sin guardar. null si no hay nada que perder.
 */
export function configLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? CONFIG_LEAVE_WARNING : null;
}
