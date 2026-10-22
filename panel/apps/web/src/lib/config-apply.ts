import type { SpecPatch } from "@mcsm/shared";
import { mergeSpecPatch } from "@mcsm/shared";
import { buildSpecPatch, type EditableSpec } from "./spec-edit";
import { diffSpecs, type DiffLine } from "./spec-diff";
import type { GuardText } from "./tab-guard";

/** Changes pending confirmation: minimal PATCH body, readable diff and whether the container is recreated. */
export interface PendingApply { name?: string; spec?: SpecPatch; changes: DiffLine[]; recreate: boolean }

export type ApplyPlan = { ok: true; pending: PendingApply } | { ok: false; error: string };

/**
 * Prepares “Apply”: minimal PATCH (first-level merge), and a diff between what is saved and what will remain after the
 * panel's merge. Any spec change recreates the container; a name-only change does not. If the spec diff ends up
 * empty, nothing is sent and no recreation is promised: only what the dialog shows is applied.
 */
export function planApply(baseName: string, baseSpec: EditableSpec, name: string, edited: EditableSpec): ApplyPlan {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "The name cannot be empty" };
  // Empty game port (or RCON port left on "auto") when editing = the panel keeps the current one (completeSpec): neither
  // “N → —” / “N → assigned on apply” nor a ports PATCH.
  const keepGame = edited.ports.game === undefined && baseSpec.ports.game !== undefined;
  const keepRcon = edited.ports.rcon === "auto" && typeof baseSpec.ports.rcon === "number";
  const spec = keepGame || keepRcon
    ? { ...edited, ports: { ...edited.ports, ...(keepGame ? { game: baseSpec.ports.game } : {}), ...(keepRcon ? { rcon: baseSpec.ports.rcon } : {}) } }
    : edited;
  const patch = buildSpecPatch(baseSpec, spec);
  const changes = Object.keys(patch).length > 0 ? diffSpecs(baseSpec, mergeSpecPatch(baseSpec, patch)) : [];
  const hasSpec = changes.length > 0;
  const renamed = trimmed !== baseName;
  if (renamed) changes.unshift({ label: "Name", before: baseName, after: trimmed });
  if (!renamed && !hasSpec) return { ok: false, error: "There are no changes to apply" };
  return { ok: true, pending: { name: renamed ? trimmed : undefined, spec: hasSpec ? patch : undefined, changes, recreate: hasSpec } };
}

/**
 * Did the configuration change outside the form? Only if the server is AHEAD of the base: right after
 * applying, the base is already N+1 and the `server` prop stays at N until setQueryData arrives; with “!==”
 * the old version was reloaded (flicker and double remount).
 */
export function isStale(serverVersion: number, baseVersion: number): boolean {
  return serverVersion > baseVersion;
}

const CONFIG_LEAVE_WARNING: GuardText = {
  title: "Unsaved changes",
  description: "There are unsaved changes in the configuration. If you leave, they will be lost.",
  confirmLabel: "Leave and discard",
};

/**
 * What to protect when leaving the Configuration tab (another tab, another page or closing the browser): its
 * unsaved changes. null if there is nothing to lose.
 */
export function configLeaveWarning(dirty: boolean): GuardText | null {
  return dirty ? CONFIG_LEAVE_WARNING : null;
}
