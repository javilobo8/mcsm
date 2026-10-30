import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  ContentCategoryDto, ContentEntryMetaDto, ContentKind, ContentListKey, ContentPlatform, ContentProjectDto, ContentSearchDto,
  ContentSearchQuery, ContentVersionDto, PackInfoDto, ResolveRequest, ResolveResultDto, UpdateDto, UpdatesRequest,
} from "@mcsm/shared";
import { api, apiPath } from "@/lib/api";

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

/** Names, icons, versions and dependencies of spec entries. Keeps the previous answer while a new list loads (no jumps). */
export function useContentLookup(items: readonly { list: ContentListKey; entry: string }[]) {
  return useQuery({
    queryKey: ["content", "lookup", items],
    queryFn: () => api.post<{ entries: ContentEntryMetaDto[] }>("/api/content/lookup", { entries: items }).then((r) => r.entries),
    enabled: items.length > 0, placeholderData: keepPreviousData, ...opts,
  });
}

export const resolveContent = (req: ResolveRequest) => api.post<ResolveResultDto>("/api/content/resolve", req);
export const checkUpdates = (req: UpdatesRequest) => api.post<{ updates: UpdateDto[] }>("/api/content/updates", req).then((r) => r.updates);

interface KeyStatus { configured: boolean; valid?: boolean }

/** Is a CurseForge key saved? Same query as `CurseForgeKeyNotice` (saving a key there updates this too). */
export function useCurseForgeConfigured(): boolean | undefined {
  return useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") }).data?.configured;
}
