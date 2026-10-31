import { keepPreviousData, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import {
  CONTENT_LISTS, parseContentEntry,
  type ContentCategoryDto, type ContentEntryMetaDto, type ContentKind, type ContentListKey, type ContentPlatform, type ContentProjectDto, type ContentSearchDto,
  type ContentSearchQuery, type ContentVersionDto, type PackInfoDto, type ResolveRequest, type ResolveResultDto, type UpdateDto, type UpdatesRequest,
  type ContentLoader, type ContentTarget,
} from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";
import { listOf } from "@/lib/content-lists";
import { installedPackIds, packDetailsError, packRefOf } from "@/lib/content-pack";
import type { EditableSpec } from "@/lib/spec-edit";

/**
 * Content browser data (route table of plan 11). The panel caches upstream answers itself; here it is enough not to
 * repeat a request within 5 minutes. No retries: a 409 (no CurseForge key) or a 502 (source down) is shown as is.
 */
const STALE_MS = 5 * 60_000;
const opts = { staleTime: STALE_MS, retry: false } as const;

export interface VersionFilter { kind: ContentKind; gameVersion?: string; loaders: string[] }

/** Query string with only the values present; lists joined with "," as the API's schemas expect. */
export function contentParams(o: Record<string, string | number | readonly string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return p.toString();
}

export const contentUrls = {
  search: (platform: ContentPlatform, q: ContentSearchQuery) =>
    `${apiPath`/api/content/${platform}/search`}?${contentParams({ kind: q.kind, q: q.q, gameVersion: q.gameVersion, loaders: q.loaders, category: q.category, sort: q.sort, offset: q.offset })}`,
  categories: (platform: ContentPlatform, kind: ContentKind) => `${apiPath`/api/content/${platform}/categories`}?${contentParams({ kind })}`,
  project: (platform: ContentPlatform, projectId: string) => apiPath`/api/content/${platform}/projects/${projectId}`,
  versions: (platform: ContentPlatform, projectId: string, f: VersionFilter) =>
    `${apiPath`/api/content/${platform}/projects/${projectId}/versions`}?${contentParams({ kind: f.kind, gameVersion: f.gameVersion, loaders: f.loaders })}`,
  pack: (platform: ContentPlatform, projectId: string, versionId: string) => apiPath`/api/content/${platform}/packs/${projectId}/${versionId}`,
};

export function useContentSearch(platform: ContentPlatform, query: ContentSearchQuery | null) {
  return useQuery({
    queryKey: ["content", "search", platform, query],
    queryFn: () => api.get<ContentSearchDto>(contentUrls.search(platform, query!)),
    enabled: query !== null, ...opts,
  });
}

export function useContentCategories(platform: ContentPlatform, kind: ContentKind, enabled: boolean) {
  return useQuery({
    queryKey: ["content", "categories", platform, kind],
    queryFn: () => api.get<{ categories: ContentCategoryDto[] }>(contentUrls.categories(platform, kind)).then((r) => r.categories),
    enabled, ...opts, staleTime: 60 * 60_000,
  });
}

export function useContentProject(platform: ContentPlatform, projectId: string | null) {
  return useQuery({
    queryKey: ["content", "project", platform, projectId],
    queryFn: () => api.get<ContentProjectDto>(contentUrls.project(platform, projectId!)),
    enabled: projectId !== null, ...opts,
  });
}

export const versionsQuery = (platform: ContentPlatform, projectId: string, filter: VersionFilter) => ({
  queryKey: ["content", "versions", platform, projectId, filter],
  queryFn: () => api.get<{ versions: ContentVersionDto[]; stale: boolean }>(contentUrls.versions(platform, projectId, filter)),
  ...opts,
});

export function useContentVersions(platform: ContentPlatform, projectId: string | null, filter: VersionFilter) {
  return useQuery({ ...versionsQuery(platform, projectId ?? "", filter), enabled: projectId !== null });
}

/** Versions of a project, from the cache when fresh (used when adding a selection whose version was not chosen). */
export const fetchContentVersions = (qc: QueryClient, platform: ContentPlatform, projectId: string, filter: VersionFilter) =>
  qc.fetchQuery(versionsQuery(platform, projectId, filter));

export const packQuery = (m: { platform: ContentPlatform; projectId: string; versionId: string }) => ({
  queryKey: ["content", "pack", m.platform, m.projectId, m.versionId],
  queryFn: () => api.get<PackInfoDto>(contentUrls.pack(m.platform, m.projectId, m.versionId)),
  // A pack version never changes: its file list is read once (the panel keeps it forever).
  staleTime: Infinity, retry: false,
});

export function usePackInfo(modpack: { platform: ContentPlatform; projectId: string; versionId: string } | null) {
  return useQuery({ ...packQuery(modpack ?? { platform: "modrinth", projectId: "", versionId: "" }), enabled: modpack !== null && modpack.versionId !== "" });
}

type LookupItems = readonly { list: ContentListKey; entry: string }[];

const lookupQuery = (items: LookupItems) => ({
  queryKey: ["content", "lookup", items],
  queryFn: () => api.post<{ entries: ContentEntryMetaDto[] }>("/api/content/lookup", { entries: items }).then((r) => r.entries),
  ...opts,
});

/** Names, icons, versions and dependencies of spec entries. Keeps the previous answer while a new list loads (no jumps). */
export function useContentLookup(items: LookupItems) {
  return useQuery({ ...lookupQuery(items), enabled: items.length > 0, placeholderData: keepPreviousData });
}

/** The lookup of `items`, from the cache when fresh. */
export const fetchContentLookup = (qc: QueryClient, items: LookupItems): Promise<ContentEntryMetaDto[]> =>
  items.length === 0 ? Promise.resolve([]) : qc.fetchQuery(lookupQuery(items));

export const resolveContent = (req: ResolveRequest) => api.post<ResolveResultDto>("/api/content/resolve", req);
export const checkUpdates = (req: UpdatesRequest) => api.post<{ updates: UpdateDto[] }>("/api/content/updates", req).then((r) => r.updates);

interface KeyStatus { configured: boolean; valid?: boolean }

/** Is a CurseForge key saved? Same query as `CurseForgeKeyNotice` (saving a key there updates this too). */
export function useCurseForgeConfigured(): boolean | undefined {
  return useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") }).data?.configured;
}

export type ListUpdate = UpdateDto & { list: ContentListKey };

/**
 * Newer compatible versions of the pinned entries of `lists`, asked once per mount (no polling: an explicit refresh is
 * reopening the tab). Unpinned entries are not asked: itzg already installs their newest compatible version.
 */
export function useContentUpdates(spec: EditableSpec, lists: readonly ContentListKey[], target: ContentTarget | null, enabled: boolean) {
  const results = useQueries({
    queries: lists.map((list) => {
      const { platform } = CONTENT_LISTS[list];
      const entries = listOf(spec, list).filter((e) => parseContentEntry(platform, e).pinned);
      return {
        queryKey: ["content", "updates", list, target, entries],
        queryFn: () => checkUpdates({ list, target: { gameVersion: target!.gameVersion, loaders: target!.loaders as ContentLoader[] }, entries })
          .then((us): ListUpdate[] => us.map((u) => ({ ...u, list }))),
        enabled: enabled && target !== null && entries.length > 0,
        refetchOnWindowFocus: false, ...opts,
      };
    }),
  });
  return {
    updates: results.flatMap((r) => r.data ?? []),
    isFetching: results.some((r) => r.isFetching),
    error: results.find((r) => r.isError)?.error ?? null,
  };
}

/**
 * The spec's pack as the panel knows it: project (a CurseForge slug is found by searching), its versions (newest
 * first) and the details of the pinned version (a Modrinth version number typed by hand is matched by label; an
 * empty version means the newest release, as itzg does). `error` says why the details will not come.
 */
export function useInstalledPack(modpack: EditableSpec["modpack"]) {
  const ref = packRefOf(modpack);
  const bySlug = ref?.platform === "curseforge" && ref.projectId === null ? ref.slug : null;
  const search = useContentSearch("curseforge", bySlug ? { kind: "modpack", q: bySlug, loaders: [], sort: "relevance", offset: 0 } : null);
  const found = search.data?.hits.find((h) => h.slug === bySlug)?.projectId ?? null;
  const versions = useContentVersions(ref?.platform ?? "modrinth", ref ? (ref.projectId ?? found) : null, { kind: "modpack", loaders: [] });
  const { projectId, versionId } = ref ? installedPackIds(ref, found, versions.data?.versions) : { projectId: null, versionId: null };
  const info = usePackInfo(ref && projectId && versionId ? { platform: ref.platform, projectId, versionId } : null);
  const slugNotFound = bySlug !== null && search.isSuccess && projectId === null;
  const error = packDetailsError({
    modpack, ref, slugNotFound, error: info.error ?? versions.error ?? search.error, versionsLoaded: versions.isSuccess, versionId,
  });
  return { ref, projectId, versionId, versions, info, slugNotFound, searchError: search.error, error };
}
