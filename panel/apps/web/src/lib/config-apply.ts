import { CONTENT_LISTS, mergeSpecPatch, type ContentEntryMetaDto, type PackInfoDto, type SpecPatch } from "@mcsm/shared";
import type { JobDto } from "./api";
import { compatFindings, removedEntries, type CompatFinding, type UncheckedEntry } from "./content-compat";
import type { PackChange } from "./content-pack";
import { browseTarget } from "./content-target";
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

// ── plan-11: content compatibility and "Back up first" in the Save confirmation ──

export const COMPAT_UNAVAILABLE = "The compatibility check could not run (content sources unreachable or no CurseForge key). You can still apply.";

/** Pinned content that will not fit the edited server: each kind checked against its own target (version + loaders). */
export function contentFindings(spec: EditableSpec, metas: readonly ContentEntryMetaDto[], pack: PackInfoDto | null): CompatFinding[] {
  return (["mod", "plugin", "datapack"] as const).flatMap((kind) => {
    const t = browseTarget(spec, kind, pack);
    return compatFindings(spec, metas.filter((m) => CONTENT_LISTS[m.list].kind === kind), t.ok ? t.target : null);
  });
}

/** PATCH body of the confirmation. `backupFirst` only travels with a spec change (a rename alone never backs up). */
export function patchBody(p: PendingApply, backupFirst: boolean): { name?: string; spec?: SpecPatch; backupFirst?: true } {
  return { ...(p.name ? { name: p.name } : {}), ...(p.spec ? { spec: p.spec } : {}), ...(backupFirst && p.spec ? { backupFirst: true as const } : {}) };
}

const BACKUP_NOT_FINISHED = "The backup did not finish: the change was not applied";

/** State of the panel's "backup, then apply" job: the change exists on the server only once the job is ok. */
export function backupFirstOutcome(job: Pick<JobDto, "status" | "message"> | undefined): { state: "waiting" } | { state: "applied" } | { state: "failed"; message: string } {
  if (!job || job.status === "queued" || job.status === "running") return { state: "waiting" };
  if (job.status === "ok") return { state: "applied" };
  return { state: "failed", message: job.message || BACKUP_NOT_FINISHED };
}

const PACK_REASON: Partial<Record<PackChange, string>> = {
  uninstall: "It uninstalls the modpack.", switch: "It switches to another modpack.",
  downgrade: "It moves the modpack to an older version.", unknown: "It changes the modpack's version.",
};

/** Why the confirmation offers "Back up first" (null when nothing risky happens to content). */
export function backupReason(base: EditableSpec, edited: EditableSpec, pack: PackChange): string | null {
  const n = removedEntries(base, edited).length;
  const parts = [PACK_REASON[pack], n > 0 ? `It removes ${n} content ${n === 1 ? "entry" : "entries"} from a server with a world.` : undefined].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

const UNAVAILABLE_WHY = { source: "content sources unreachable", no_key: "no CurseForge key" } as const;

/**
 * What the confirmation says when (part of) the check could not run: the whole lookup failed, or some pinned entries
 * could not be checked (named, with why). Null when everything was checked. Save stays enabled either way.
 */
export function compatUnavailableNote(unchecked: readonly UncheckedEntry[], lookupFailed: boolean): string | null {
  if (lookupFailed) return COMPAT_UNAVAILABLE;
  if (unchecked.length === 0) return null;
  const reasons = [...new Set(unchecked.map((u) => u.reason))].sort((a, b) => (a === "source" ? -1 : b === "source" ? 1 : 0));
  const why = reasons.map((r) => UNAVAILABLE_WHY[r]).join(" or ");
  return `The compatibility check could not run for ${unchecked.map((u) => u.entry).join(", ")} (${why}). You can still apply.`;
}

/** The chained job's outcome as a notice for the form (outside the dialog, until dismissed); null while it runs. */
export function backupFirstNotice(outcome: ReturnType<typeof backupFirstOutcome>, specVersion: number | null): { tone: "ok" | "bad"; text: string } | null {
  if (outcome.state === "waiting") return null;
  if (outcome.state === "applied") return { tone: "ok", text: `Backed up and saved${specVersion !== null ? ` (v${specVersion})` : ""}. The agent will recreate the container if needed.` };
  return { tone: "bad", text: `${outcome.message.replace(/\.$/, "")}. Your changes are still in the form: review them and apply again.` };
}
