import type {
  ContentCategoryDto, ContentKind, ContentPlatform, ContentProjectDto, ContentSearchDto, ContentSort, ContentVersionDto,
  PackInfoDto, ParsedEntry,
} from "@mcsm/shared";
import { IMAGE_HOSTS, allowedUrl } from "./http.js";

export interface SearchInput { kind: ContentKind; q: string; gameVersion: string | null; loaders: string[]; category: string | null; sort: ContentSort; offset: number }
export interface VersionFilter { kind: ContentKind; gameVersion: string | null; loaders: string[] }
export interface ContentRef { projectId: string; versionId: string | null }
/** `resolveRefs` result for an entry the source could not be asked about (failure, rate limit, timeout, no key). */
export const REF_UNAVAILABLE = "unavailable" as const;
export type RefResult = ContentRef | null | typeof REF_UNAVAILABLE;
export interface ProjectMeta { projectId: string; slug: string; name: string; author: string; iconUrl: string | null; clientOnly: boolean; distributable: boolean }

/** One content platform (Modrinth, CurseForge). Every failure comes out as an HttpError with an English message. */
export interface ContentAdapter {
  readonly platform: ContentPlatform;
  search(q: SearchInput): Promise<ContentSearchDto>;
  categories(kind: ContentKind): Promise<ContentCategoryDto[]>;
  project(projectId: string): Promise<ContentProjectDto>;
  projects(ids: string[]): Promise<ProjectMeta[]>;
  versions(projectId: string, f: VersionFilter): Promise<{ versions: ContentVersionDto[]; stale: boolean }>;
  versionsByIds(ids: string[]): Promise<ContentVersionDto[]>;
  /** Raw entries → ids, in order, batched where the source allows it; null = unknown, REF_UNAVAILABLE = the source failed. */
  resolveRefs(es: ParsedEntry[], kind: ContentKind): Promise<RefResult[]>;
  /**
   * Newest version each current version may move to on the filter's target, honouring its channel (pickLatest's rule),
   * batched. Key = current versionId; null = the source knows none; a key left out = it could not be checked.
   */
  latestFor(current: ContentVersionDto[], f: VersionFilter): Promise<Map<string, ContentVersionDto | null>>;
  pack(projectId: string, versionId: string): Promise<PackInfoDto>;
}

export const SEARCH_LIMIT = 20;
export const PACK_MAX_BYTES = 64 * 1024 * 1024;
export const PACK_TIMEOUT_MS = 60_000;
export const VERSIONS_MAX = 200;
/** pickLatest's channel rule as the channels a version may move to. */
export const ALLOWED_CHANNELS = {
  release: ["release"], beta: ["release", "beta"], alpha: ["release", "beta", "alpha"],
} as const satisfies Record<string, readonly ("release" | "beta" | "alpha")[]>;
/** Ids per batch request (both platforms take at most 100). */
export const BATCH_SIZE = 100;

export const PACK_TOO_LARGE = "The pack is too large to inspect (over 64 MiB)";
export const PACK_UNREADABLE = "Could not read the pack's file list";

/** Panel proxy path for an image on an allowed CDN (the browser never loads a third-party URL); else null. */
export function proxiedImage(url: string | null | undefined): string | null {
  if (!url || !allowedUrl(url, IMAGE_HOSTS)) return null;
  return `/api/content/image?url=${encodeURIComponent(url)}`;
}

/** Upstream dates to UTC ISO-8601 (pickLatest compares them as strings); null when unparseable. */
export function isoDate(s: string): string | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function chunks<T>(xs: readonly T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Newest first, then the first `max`. */
export function newestFirst<V extends { publishedAt: string }>(vs: V[], max = VERSIONS_MAX): V[] {
  return [...vs].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0)).slice(0, max);
}
