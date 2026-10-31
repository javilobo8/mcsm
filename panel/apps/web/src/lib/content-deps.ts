import { CONTENT_LISTS, parseContentEntry, type ContentEntryMetaDto, type ResolveResultDto } from "@mcsm/shared";
import { listOf, withList } from "./content-lists";
import type { EditableSpec } from "./spec-edit";

/**
 * Dependencies derived at display time from the pinned versions' declared dependencies (no per-server provenance
 * is stored: see the content browser spec, "Calls made by the designer", item 1).
 */

const requires = (m: ContentEntryMetaDto, projectId: string) =>
  m.projectId !== projectId && m.dependencies.some((d) => d.type === "required" && d.projectId === projectId);
const nameOf = (m: ContentEntryMetaDto) => m.name ?? m.raw;

/** Names of the present entries whose version requires `projectId` (empty: nobody needs it). */
export function dependentsOf(projectId: string, metas: readonly ContentEntryMetaDto[]): string[] {
  return [...new Set(metas.filter((m) => requires(m, projectId)).map(nameOf))];
}

/**
 * Entries in `remaining` that only existed for `removed`: required by a removed entry and by nothing that stays.
 * Follows chains (a library of a dependency that also becomes unused).
 */
export function unusedAfterRemoval(removed: readonly ContentEntryMetaDto[], remaining: readonly ContentEntryMetaDto[]): ContentEntryMetaDto[] {
  const out: ContentEntryMetaDto[] = [];
  let keep = [...remaining];
  let gone = [...removed];
  for (;;) {
    const wanted = new Set(gone.flatMap((m) => m.dependencies.filter((d) => d.type === "required" && d.projectId).map((d) => d.projectId!)));
    const unused = keep.filter((c) => c.projectId !== null && wanted.has(c.projectId) && !keep.some((k) => k !== c && requires(k, c.projectId!)));
    if (unused.length === 0) return out;
    out.push(...unused);
    keep = keep.filter((k) => !unused.includes(k));
    gone = unused;
  }
}

/**
 * Writes the resolver's pinned entries into their lists. Whatever already names the same project is replaced (the
 * first one keeps its place, the rest go): another pinned version, or a hand-typed slug that `metas` (the lookup of
 * the list's entries) resolved to that project. Two entries of one project would install two jars of it.
 */
export function applyResolved(spec: EditableSpec, result: ResolveResultDto, metas: readonly ContentEntryMetaDto[] = []): EditableSpec {
  let next = spec;
  for (const r of result.add) {
    const { platform } = CONTENT_LISTS[r.list];
    const list = listOf(next, r.list);
    const same = (raw: string) => raw === r.entry || parseContentEntry(platform, raw).projectRef === r.projectId
      || metas.some((m) => m.list === r.list && m.raw === raw && m.projectId === r.projectId);
    const first = list.findIndex(same);
    const items = first < 0 ? [...list, r.entry] : list.flatMap((raw, j) => (j === first ? [r.entry] : same(raw) ? [] : [raw]));
    if (items.length !== list.length || items.some((x, j) => x !== list[j])) next = withList(next, r.list, items);
  }
  return next;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Confirm label: "Add 2 projects + 3 dependencies". */
export function addSummary(result: ResolveResultDto): string {
  const selected = result.add.filter((e) => e.selected).length;
  const deps = result.add.length - selected;
  if (result.add.length === 0) return "Nothing new to add";
  return `Add ${plural(selected, "project", "projects")}${deps ? ` + ${plural(deps, "dependency", "dependencies")}` : ""}`;
}

const PLATFORM_LABEL = { modrinth: "Modrinth", curseforge: "CurseForge" } as const;
const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

/** Heuristic only (same slug or name): a selected project that looks installed from the other platform. Never blocks. */
export function crossPlatformWarnings(selected: readonly { name: string; slug: string }[], others: readonly ContentEntryMetaDto[]): string[] {
  const out: string[] = [];
  for (const s of selected) {
    const twin = others.find((m) => m.resolved && ((m.slug !== null && norm(m.slug) === norm(s.slug)) || (m.name !== null && norm(m.name) === norm(s.name))));
    if (twin) out.push(`${s.name} is already installed from ${PLATFORM_LABEL[CONTENT_LISTS[twin.list].platform]}`);
  }
  return out;
}
