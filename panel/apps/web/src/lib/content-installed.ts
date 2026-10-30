import {
  CONTENT_LISTS, CONTENT_LIST_KEYS, parseContentEntry,
  type ContentEntryMetaDto, type ContentUnavailable, type ContentListKey, type ContentPlatform, type UpdateDto,
} from "@mcsm/shared";
import { dependentsOf } from "./content-deps";
import { listOf } from "./content-lists";
import type { EditableSpec } from "./spec-edit";

/** One row of a content section's installed list. */
export interface InstalledRow {
  list: ContentListKey;
  raw: string;
  name: string;
  iconUrl: string | null;
  platform: ContentPlatform;
  versionLabel: string | null;
  /** `id:id` entries; anything else lets itzg pick the newest compatible version ("latest") or is as typed. */
  pinned: boolean;
  /** Names of the present entries whose version requires this one. */
  dependencyOf: string[];
  update: UpdateDto["latest"];
  /** false: the update check could not reach the source for this entry (unknown, not "up to date"). */
  checked: boolean;
  /** false: the panel does not know this entry (or has not looked it up yet): shown as typed. */
  resolved: boolean;
  /** Unresolved because the platform could not be asked ("source") or CurseForge has no key ("no_key"); null = not found. */
  unavailable: ContentUnavailable | null;
}

const group = (r: InstalledRow) => (!r.resolved ? 2 : r.dependencyOf.length > 0 ? 1 : 0);

/** Rows of every content list: projects the admin picked first (by name), then dependencies, then raw entries. */
export function installedRows(spec: EditableSpec, metas: readonly ContentEntryMetaDto[], updates: readonly (UpdateDto & { list: ContentListKey })[]): InstalledRow[] {
  const present = metas.filter((m) => listOf(spec, m.list).includes(m.raw));
  const rows: InstalledRow[] = [];
  for (const list of CONTENT_LIST_KEYS) {
    const { platform } = CONTENT_LISTS[list];
    for (const raw of listOf(spec, list)) {
      const m = present.find((x) => x.list === list && x.raw === raw);
      const resolved = m?.resolved === true;
      const u = updates.find((x) => x.list === list && x.entry === raw);
      rows.push({
        list, raw, platform,
        name: (resolved && m.name) || raw,
        iconUrl: resolved ? m.iconUrl : null,
        versionLabel: resolved ? m.versionLabel : null,
        pinned: parseContentEntry(platform, raw).pinned,
        dependencyOf: resolved && m.projectId ? dependentsOf(m.projectId, present) : [],
        update: u?.latest ?? null,
        checked: u?.checked ?? true,
        resolved,
        unavailable: resolved ? null : (m?.unavailable ?? null),
      });
    }
  }
  return rows.sort((a, b) => group(a) - group(b) || (group(a) === 2 ? 0 : a.name.localeCompare(b.name, "en", { sensitivity: "base" })));
}

/**
 * Which note an unresolved row shows. "Not found" only when the platform answered and does not know the entry; a failed
 * lookup or an unreachable platform is "unavailable", CurseForge without a key "no_key", and no answer yet "loading".
 */
export function unresolvedNote(row: Pick<InstalledRow, "resolved" | "unavailable">, o: { loading: boolean; lookupFailed: boolean }): "loading" | "unavailable" | "no_key" | "not_found" | null {
  if (row.resolved) return null;
  if (o.lookupFailed || row.unavailable === "source") return "unavailable";
  if (row.unavailable === "no_key") return "no_key";
  return o.loading ? "loading" : "not_found";
}
