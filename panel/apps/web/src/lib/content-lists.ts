import { CONTENT_LISTS, CONTENT_LIST_KEYS, type ContentListKey, type ContentPlatform } from "@mcsm/shared";
import type { EditableSpec } from "./spec-edit";

/**
 * The spec's content lists (mods, plugins, datapacks) read and written by key ("mods.modrinthProjects"…).
 * Pure: the browser, the installed list and "Edit as text" all edit these same string lists.
 */

type Sections = Pick<EditableSpec, "mods" | "plugins" | "datapacks">;

/** Defaults of a section that does not exist yet. Plugins never get `curseforgeFiles` unless it is the list being set. */
function emptySection(section: keyof Sections): Record<string, string[]> {
  if (section === "mods") return { modrinthProjects: [], curseforgeFiles: [], urls: [] };
  if (section === "plugins") return { modrinthProjects: [], spigetResources: [], urls: [] };
  return { modrinthProjects: [] };
}

export function listOf(spec: EditableSpec, key: ContentListKey): string[] {
  const { section, field } = CONTENT_LISTS[key];
  const s = spec[section] as Record<string, string[] | undefined> | undefined;
  return s?.[field] ?? [];
}

/** Sets one list, creating its section with the defaults when absent. */
export function withList(spec: EditableSpec, key: ContentListKey, items: string[]): EditableSpec {
  const { section, field } = CONTENT_LISTS[key];
  const current = (spec[section] as Record<string, string[]> | undefined) ?? emptySection(section);
  return { ...spec, [section]: { ...current, [field]: items } };
}

/** Every entry of `platform`, with its list (what the resolver receives as "present"). */
export function presentFor(spec: EditableSpec, platform: ContentPlatform): { list: ContentListKey; entry: string }[] {
  return CONTENT_LIST_KEYS.filter((k) => CONTENT_LISTS[k].platform === platform).flatMap((list) => listOf(spec, list).map((entry) => ({ list, entry })));
}

/** Removes the given raw entries; a spec without that list comes back untouched (no section is created). */
export function removeEntries(spec: EditableSpec, key: ContentListKey, raws: readonly string[]): EditableSpec {
  const list = listOf(spec, key);
  const next = list.filter((e) => !raws.includes(e));
  return next.length === list.length ? spec : withList(spec, key, next);
}

/** Replaces one entry in place; if the new one is already in the list, the old one is just dropped. */
export function replaceEntry(spec: EditableSpec, key: ContentListKey, oldRaw: string, newRaw: string): EditableSpec {
  const list = listOf(spec, key);
  if (!list.includes(oldRaw) || oldRaw === newRaw) return spec;
  const next = list.includes(newRaw) ? list.filter((e) => e !== oldRaw) : list.map((e) => (e === oldRaw ? newRaw : e));
  return withList(spec, key, next);
}
