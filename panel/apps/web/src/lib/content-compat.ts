import {
  CONTENT_LISTS, CONTENT_LIST_KEYS, isFloatingVersion, parseContentEntry,
  type ContentEntryMetaDto, type ContentListKey, type ContentTarget, type UpdateDto,
} from "@mcsm/shared";
import { listOf, replaceEntry } from "./content-lists";
import { isPackType } from "./content-target";
import type { PackChange } from "./content-pack";
import type { EditableSpec } from "./spec-edit";

/**
 * Compatibility check shown in the Save confirmation (a warning, never a gate): pinned entries skip itzg's own
 * compatibility check, so a version or loader change must be checked here.
 */

export type CompatFinding = { list: ContentListKey; entry: string; name: string; problem: "incompatible" | "floating" };

const pinned = (m: ContentEntryMetaDto) => parseContentEntry(CONTENT_LISTS[m.list].platform, m.raw).pinned;

function fits(m: ContentEntryMetaDto, t: ContentTarget): boolean {
  if (m.gameVersions.length > 0 && !m.gameVersions.includes(t.gameVersion)) return false;
  if (m.loaders.length > 0 && t.loaders.length > 0 && !m.loaders.some((l) => t.loaders.includes(l))) return false;
  return true;
}

/**
 * Pinned entries of `metas` (still in the spec) that do not fit `target`. With no target: on a floating version every
 * pinned entry is flagged (LATEST/SNAPSHOT will move away from it); otherwise the target is not known yet and nothing is.
 */
export function compatFindings(spec: EditableSpec, metas: readonly ContentEntryMetaDto[], target: ContentTarget | null): CompatFinding[] {
  const floating = target === null && isFloatingVersion(spec.version) && !isPackType(spec.type);
  if (target === null && !floating) return [];
  return metas
    .filter((m) => m.resolved && pinned(m) && listOf(spec, m.list).includes(m.raw))
    .filter((m) => floating || !fits(m, target!))
    .map((m) => ({ list: m.list, entry: m.raw, name: m.name ?? m.raw, problem: floating ? "floating" : "incompatible" }));
}

/**
 * Did the panel manage to check this entry? `checked: false` (upstream failure) makes `latest: null` mean "unknown",
 * never "up to date". A missing field (older API) counts as checked.
 */
export const updateChecked = (u: UpdateDto): boolean => (u as UpdateDto & { checked?: boolean }).checked !== false;

/** Moves entries to their newest compatible version; returns the raws that have none. */
export function applyUpdates(spec: EditableSpec, updates: readonly (UpdateDto & { list: ContentListKey })[]): { spec: EditableSpec; withoutVersion: string[] } {
  let next = spec;
  const withoutVersion: string[] = [];
  for (const u of updates) {
    if (u.latest && u.latest.entry !== u.entry) next = replaceEntry(next, u.list, u.entry, u.latest.entry);
    else if (!u.latest && !u.compatible && updateChecked(u)) withoutVersion.push(u.entry);
  }
  return { spec: next, withoutVersion };
}

/** Projects that leave the server (an entry of the same project with another version is an update, not a removal). */
export function removedEntries(base: EditableSpec, edited: EditableSpec): { list: ContentListKey; entry: string }[] {
  const out: { list: ContentListKey; entry: string }[] = [];
  for (const list of CONTENT_LIST_KEYS) {
    const { platform } = CONTENT_LISTS[list];
    const kept = new Set(listOf(edited, list).map((raw) => parseContentEntry(platform, raw).projectRef));
    for (const entry of listOf(base, list)) if (!kept.has(parseContentEntry(platform, entry).projectRef)) out.push({ list, entry });
  }
  return out;
}

const RISKY_PACK: ReadonlySet<PackChange> = new Set(["downgrade", "switch", "uninstall", "unknown"]);

/** Offer "Back up first"? Only when the change can break a world that exists (unknown counts as existing). */
export function backupOffer(o: { base: EditableSpec; edited: EditableSpec; packChange: PackChange; hasWorld: boolean | null }): boolean {
  return o.hasWorld !== false && (removedEntries(o.base, o.edited).length > 0 || RISKY_PACK.has(o.packChange));
}
