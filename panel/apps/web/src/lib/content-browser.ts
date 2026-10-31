import {
  parseContentEntry, pickLatest,
  type ContentKind, type ContentListKey, type ContentLoader, type ContentPlatform, type ContentSearchQuery, type ContentSort, type ContentTarget,
  type ContentVersionDto, type PackInfoDto,
} from "@mcsm/shared";
import { presentFor } from "./content-lists";
import type { BrowserTab } from "./content-target";
import type { EditableSpec } from "./spec-edit";

/** State of the content browser dialog. Pure: the dialog only dispatches actions and renders. */

/** Page size of the panel's search (the API asks the platforms for 20 hits). */
export const SEARCH_LIMIT = 20;

/**
 * A project picked in the browser. `versionId` "" = not chosen yet: the newest compatible version is used when
 * adding. `list` is the spec list it goes to (null for modpacks, which go to the `modpack` section).
 */
export interface Selected { projectId: string; versionId: string; name: string; slug: string; list: ContentListKey | null }

export interface BrowserState {
  tab: BrowserTab;
  q: string;
  category: string | null;
  sort: ContentSort;
  offset: number;
  /** Project shown in the detail pane. */
  detail: string | null;
  selected: Map<string, Selected>;
  /** Modpacks only: search every Minecraft version, not just the server's. */
  anyVersion: boolean;
}

export type BrowserAction =
  | { type: "tab"; tab: BrowserTab }
  | { type: "query"; q: string }
  | { type: "category"; category: string | null }
  | { type: "sort"; sort: ContentSort }
  | { type: "page"; offset: number }
  | { type: "open"; projectId: string | null }
  | { type: "toggle"; item: Selected }
  | { type: "version"; projectId: string; versionId: string }
  | { type: "anyVersion"; on: boolean }
  | { type: "clear" };

export function initialBrowserState(tab: BrowserTab, o: { anyVersion?: boolean } = {}): BrowserState {
  return { tab, q: "", category: null, sort: "relevance", offset: 0, detail: null, selected: new Map(), anyVersion: o.anyVersion ?? false };
}

/** A new search: back to the first page and no detail open. */
const research = (s: BrowserState, patch: Partial<BrowserState>): BrowserState => ({ ...s, ...patch, offset: 0, detail: null });

export function browserReducer(s: BrowserState, a: BrowserAction): BrowserState {
  switch (a.type) {
    // Each tab writes to its own list: a selection never travels across tabs. Categories are per platform and kind.
    case "tab": return research(s, { tab: a.tab, category: null, selected: new Map() });
    case "query": return research(s, { q: a.q });
    case "category": return research(s, { category: a.category });
    case "sort": return research(s, { sort: a.sort });
    case "anyVersion": return research(s, { anyVersion: a.on });
    case "page": return { ...s, offset: a.offset };
    case "open": return { ...s, detail: a.projectId };
    case "toggle": {
      const has = s.selected.has(a.item.projectId);
      // A server runs one modpack: picking another replaces the choice.
      const next = s.tab.kind === "modpack" ? new Map<string, Selected>() : new Map(s.selected);
      if (has) next.delete(a.item.projectId);
      else next.set(a.item.projectId, a.item);
      return { ...s, selected: next };
    }
    case "version": {
      const cur = s.selected.get(a.projectId);
      if (!cur || cur.versionId === a.versionId) return s;
      return { ...s, selected: new Map(s.selected).set(a.projectId, { ...cur, versionId: a.versionId }) };
    }
    case "clear": return { ...s, selected: new Map() };
  }
}

/** Query for `GET /api/content/:platform/search`; null while the target (version, loaders) is not known. */
export function searchQuery(s: BrowserState, target: ContentTarget | null): ContentSearchQuery | null {
  if (!target) return null;
  const anyVersion = s.tab.kind === "modpack" && s.anyVersion;
  return {
    kind: s.tab.kind,
    q: s.q.trim(),
    ...(!anyVersion && target.gameVersion ? { gameVersion: target.gameVersion } : {}),
    // Targets come from modrinthLoadersFor, which only returns known loaders.
    loaders: target.loaders as ContentLoader[],
    ...(s.category ? { category: s.category } : {}),
    sort: s.sort,
    offset: s.offset,
  };
}

/** Version pre-selected in the detail pane: the current choice while installable, else the newest installable release. */
export function defaultVersionId(versions: readonly ContentVersionDto[], current: string | null): string | null {
  const installable = versions.filter((v) => v.installable);
  if (current && installable.some((v) => v.versionId === current)) return current;
  return pickLatest(installable, null)?.versionId ?? null;
}

// ── Result badges and labels ──

/** Project refs (ids or hand-typed slugs) already on the server for `platform`, the installed pack included. */
export function installedRefs(spec: EditableSpec, platform: ContentPlatform): Set<string> {
  const refs = new Set(presentFor(spec, platform).map((p) => parseContentEntry(platform, p.entry).projectRef));
  const packPlatform = platform === "modrinth" ? "MODRINTH" : "AUTO_CURSEFORGE";
  if (spec.modpack?.platform === packPlatform && spec.modpack.slugOrUrl) refs.add(spec.modpack.slugOrUrl);
  return refs;
}

/** Projects the installed pack brings, on `platform` (other platforms only match heuristically, by name). */
export function packContents(pack: Pick<PackInfoDto, "contents"> | null, platform: ContentPlatform): Set<string> {
  return new Set((pack?.contents ?? []).filter((c) => c.platform === platform).map((c) => c.projectId));
}

export function hitStatus(hit: { projectId: string; slug: string }, installed: ReadonlySet<string>, inPack: ReadonlySet<string>): "installed" | "in-modpack" | null {
  if (installed.has(hit.projectId) || installed.has(hit.slug)) return "installed";
  if (inPack.has(hit.projectId)) return "in-modpack";
  return null;
}

const KIND_LABEL: Record<ContentKind, string> = { mod: "Mods", plugin: "Plugins", datapack: "Datapacks", modpack: "Modpacks" };
export const kindLabel = (k: ContentKind): string => KIND_LABEL[k];
export const platformLabel = (p: ContentPlatform): string => (p === "modrinth" ? "Modrinth" : "CurseForge");

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumSignificantDigits: 2 });
export const formatDownloads = (n: number): string => compact.format(n);
