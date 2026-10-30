import {
  CF_CLASS_ID, CF_GAME_ID, CF_ID_RE, curseforgeLoaderFor, pickLatest, type ContentCategoryDto, type ContentDependencyDto, type ContentKind,
  type ContentProjectDto, type ContentSearchDto, type ContentVersionDto, type PackInfoDto, type ParsedEntry,
} from "@mcsm/shared";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { UpstreamError } from "../versions/sources.js";
import {
  PACK_MAX_BYTES, PACK_TIMEOUT_MS, PACK_TOO_LARGE, PACK_UNREADABLE, SEARCH_LIMIT, chunks, isoDate, newestFirst, proxiedImage,
  type ContentAdapter, type ContentRef, type ProjectMeta, type SearchInput, type VersionFilter,
} from "./adapter.js";
import { DOWNLOAD_HOSTS, TOO_LARGE, type JsonRequest, type UpstreamClient } from "./http.js";
import { readCurseForgeManifest } from "./pack.js";
import type { ContentMetaRepo } from "./repo.js";
import { descriptionHtml } from "./sanitize.js";

const API = "https://api.curseforge.com/v1";

const SEARCH_TTL = 300_000;
const CATEGORIES_TTL = 24 * 3_600_000;
const PROJECT_TTL = 3_600_000;
const VERSIONS_TTL = 15 * 60_000;
/** Newest files per project that the version list shows. */
const FILES_PAGE = 50;
/** CurseForge refuses `index + pageSize` above this. */
const SEARCH_WINDOW = 10_000;

export const NO_KEY_MESSAGE = "Save a CurseForge API key in Settings to browse CurseForge";
export const CURSEFORGE_KEY_REJECTED = "CurseForge rejected the API key: check it in Settings";
export const CURSEFORGE_RATE_LIMITED = "CurseForge is rate limiting the panel: try again in a minute";
export const CURSEFORGE_FAILED = "Could not query CurseForge";
export const NOT_DISTRIBUTABLE = "The author does not allow third-party downloads: the server cannot install it";

// ── Upstream documents ──

const date = z.string().refine((s) => isoDate(s) !== null, "invalid date");
const pagination = z.object({ index: z.number(), pageSize: z.number(), resultCount: z.number(), totalCount: z.number() });

const modSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  summary: z.string().nullish(),
  links: z.object({
    websiteUrl: z.string().nullish(), wikiUrl: z.string().nullish(), issuesUrl: z.string().nullish(), sourceUrl: z.string().nullish(),
  }).nullish(),
  downloadCount: z.number(),
  classId: z.number().nullish(),
  categories: z.array(z.object({ name: z.string() })).nullish(),
  authors: z.array(z.object({ name: z.string() })).nullish(),
  logo: z.object({ thumbnailUrl: z.string().nullish() }).nullish(),
  screenshots: z.array(z.object({ url: z.string() })).nullish(),
  allowModDistribution: z.boolean().nullish(),
  latestFilesIndexes: z.array(z.object({
    gameVersion: z.string(),
    fileId: z.number().int().positive(),
    releaseType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    modLoader: z.number().int().nullish(),
  })).nullish(),
});
type ModDoc = z.infer<typeof modSchema>;

const fileSchema = z.object({
  id: z.number().int(),
  modId: z.number().int(),
  displayName: z.string(),
  releaseType: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  fileDate: date,
  downloadUrl: z.string().nullish(),
  gameVersions: z.array(z.string()),
  dependencies: z.array(z.object({ modId: z.number().int(), relationType: z.number().int() })).nullish(),
});
type FileDoc = z.infer<typeof fileSchema>;

const searchSchema = z.object({ data: z.array(modSchema), pagination });
const modDoc = z.object({ data: modSchema });
const modsDoc = z.object({ data: z.array(modSchema) });
const descriptionDoc = z.object({ data: z.string() });
const filesDoc = z.object({ data: z.array(fileSchema) });
const fileDoc = z.object({ data: fileSchema });
const categoriesDoc = z.object({ data: z.array(z.object({ id: z.number().int(), name: z.string(), isClass: z.boolean().nullish() })) });

const SORT_FIELD = { relevance: 2, downloads: 6, newest: 11, updated: 3 } as const;
const RELEASE_TYPE = { 1: "release", 2: "beta", 3: "alpha" } as const;
const RELATION: Readonly<Record<number, ContentDependencyDto["type"]>> = { 3: "required", 2: "optional", 5: "incompatible", 1: "embedded" };
const LOADER_NAMES = new Set(["forge", "fabric", "quilt", "neoforge"]);
const PACK_LOADERS = new Set<string>(["fabric", "forge", "neoforge", "quilt"]);
const GAME_VERSION_RE = /^\d+\.\d+(\.\d+)?(-.+)?$/;
const SNAPSHOT_RE = /^\d{2}w\d{2}[a-z]$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PAGE_SEGMENT = { 6: "mc-mods", 5: "bukkit-plugins", 4471: "modpacks" } as const;

const cfId = (n: number): string | null => { const s = String(n); return CF_ID_RE.test(s) ? s : null; };
const safeLink = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

/** CurseForge Core API. The key is read at call time and travels only in the `x-api-key` header. */
export class CurseForgeAdapter implements ContentAdapter {
  readonly platform = "curseforge" as const;

  constructor(private readonly http: UpstreamClient, private readonly repo: ContentMetaRepo, private readonly key: () => string | null) {}

  async search(q: SearchInput): Promise<ContentSearchDto> {
    const params = new URLSearchParams({ gameId: String(CF_GAME_ID), classId: String(classOf(q.kind)) });
    if (q.q !== "") params.set("searchFilter", q.q);
    if (q.gameVersion !== null) {
      params.set("gameVersion", q.gameVersion);
      // The API only takes the loader together with the game version; plugins have no loader type.
      const loader = q.kind === "mod" ? curseforgeLoaderFor(q.loaders) : null;
      if (loader !== null) params.set("modLoaderType", String(loader));
    }
    if (q.category !== null) params.set("categoryId", q.category);
    params.set("sortField", String(SORT_FIELD[q.sort]));
    params.set("sortOrder", "desc");
    params.set("index", String(q.offset));
    params.set("pageSize", String(SEARCH_LIMIT));
    const r = await this.get({ url: `${API}/mods/search?${params}`, ttlMs: SEARCH_TTL }, searchSchema);
    const hits = r.data.data.flatMap((m) => {
      const projectId = cfId(m.id);
      return projectId ? [{ ...hitOf(m, projectId) }] : [];
    });
    const p = r.data.pagination;
    return { hits, total: Math.min(p.totalCount, SEARCH_WINDOW), offset: p.index, limit: p.pageSize, stale: r.stale };
  }

  async categories(kind: ContentKind): Promise<ContentCategoryDto[]> {
    const params = new URLSearchParams({ gameId: String(CF_GAME_ID), classId: String(classOf(kind)) });
    const r = await this.get({ url: `${API}/categories?${params}`, ttlMs: CATEGORIES_TTL }, categoriesDoc);
    return r.data.data.filter((c) => c.isClass !== true).map((c) => ({ id: String(c.id), label: c.name }));
  }

  async project(projectId: string): Promise<ContentProjectDto> {
    const id = this.id(projectId);
    const m = await this.mod(id);
    const html = (await this.get({ url: `${API}/mods/${id}/description`, ttlMs: PROJECT_TTL }, descriptionDoc)).data.data;
    const meta = metaOf(m, id);
    this.repo.put("curseforge", "project", id, meta);
    const links = ([["Wiki", m.links?.wikiUrl], ["Issues", m.links?.issuesUrl], ["Source", m.links?.sourceUrl]] as const)
      .flatMap(([label, u]) => { const url = safeLink(u); return url ? [{ label, url }] : []; });
    const segment = m.classId != null && m.classId in PAGE_SEGMENT ? PAGE_SEGMENT[m.classId as keyof typeof PAGE_SEGMENT] : "mc-mods";
    return {
      ...hitOf(m, id), descriptionHtml: descriptionHtml({ html }),
      gallery: (m.screenshots ?? []).flatMap((s) => { const u = proxiedImage(s.url); return u ? [u] : []; }),
      links, pageUrl: safeLink(m.links?.websiteUrl) ?? `https://www.curseforge.com/minecraft/${segment}/${encodeURIComponent(m.slug)}`,
      clientOnly: false, distributable: meta.distributable,
    };
  }

  async projects(ids: string[]): Promise<ProjectMeta[]> {
    this.headers();
    const out: ProjectMeta[] = [];
    for (const part of chunks([...new Set(ids.filter((id) => CF_ID_RE.test(id)))])) {
      for (const m of await this.modsBatch(part)) {
        const id = cfId(m.id);
        if (!id) continue;
        const meta = metaOf(m, id);
        this.repo.put("curseforge", "project", id, meta);
        out.push(meta);
      }
    }
    return out;
  }

  async versions(projectId: string, f: VersionFilter): Promise<{ versions: ContentVersionDto[]; stale: boolean }> {
    const id = this.id(projectId);
    const params = new URLSearchParams();
    if (f.gameVersion !== null) params.set("gameVersion", f.gameVersion);
    const loader = f.kind === "mod" ? curseforgeLoaderFor(f.loaders) : null;
    if (loader !== null) params.set("modLoaderType", String(loader));
    params.set("index", "0");
    params.set("pageSize", String(FILES_PAGE));
    const r = await this.get({ url: `${API}/mods/${id}/files?${params}`, ttlMs: VERSIONS_TTL }, filesDoc, "Project not found on CurseForge");
    return { versions: newestFirst(this.store(r.data.data)), stale: r.stale };
  }

  async versionsByIds(ids: string[]): Promise<ContentVersionDto[]> {
    this.headers();
    const wanted = [...new Set(ids.filter((id) => CF_ID_RE.test(id)))];
    const out: ContentVersionDto[] = [];
    for (const part of chunks(wanted)) {
      const r = await this.get({
        url: `${API}/mods/files`, method: "POST", body: { fileIds: part.map(Number) },
        cacheKey: `curseforge files ${part.join(",")}`, ttlMs: VERSIONS_TTL,
      }, filesDoc);
      out.push(...this.store(r.data.data));
    }
    return out;
  }

  /** Numeric refs need no request; a slug is looked up through search (CurseForge has no batch slug lookup), cached as a ref. */
  async resolveRefs(es: ParsedEntry[], kind: ContentKind): Promise<(ContentRef | null)[]> {
    const out: (ContentRef | null)[] = [];
    for (const e of es) {
      try {
        out.push(await this.resolveOne(e, kind));
      } catch {
        out.push(null); // no key or the source failed: unresolved
      }
    }
    return out;
  }

  async latestFor(current: ContentVersionDto[], f: VersionFilter): Promise<Map<string, ContentVersionDto | null>> {
    this.headers();
    const out = new Map<string, ContentVersionDto | null>();
    if (f.gameVersion === null) return out;
    const loader = f.kind === "mod" ? curseforgeLoaderFor(f.loaders) : null;
    // Newest file per (game version, loader, channel) of each mod, from the batched mod documents.
    const chosen = new Map<string, string | null>(); // current versionId → chosen fileId
    for (const part of chunks([...new Set(current.map((v) => v.projectId).filter((id) => CF_ID_RE.test(id)))])) {
      let mods: ModDoc[];
      try {
        mods = await this.modsBatch(part);
      } catch {
        continue; // not checked
      }
      for (const m of mods) {
        const pid = cfId(m.id);
        const files = (m.latestFilesIndexes ?? [])
          .filter((ix) => ix.gameVersion === f.gameVersion && (loader === null || !ix.modLoader || ix.modLoader === loader))
          // File ids grow with time: zero-padded, they order like publishedAt for pickLatest.
          .map((ix) => ({ fileId: String(ix.fileId), type: RELEASE_TYPE[ix.releaseType], publishedAt: String(ix.fileId).padStart(16, "0") }));
        for (const v of current) {
          if (v.projectId === pid) chosen.set(v.versionId, pickLatest(files, v.type)?.fileId ?? null);
        }
      }
    }
    const wanted = [...new Set([...chosen.values()].filter((x): x is string => x !== null))];
    let found = new Map<string, ContentVersionDto>();
    if (wanted.length > 0) {
      try {
        found = new Map((await this.versionsByIds(wanted)).map((v) => [v.versionId, v]));
      } catch { /* the chosen files stay unknown: not checked */ }
    }
    for (const [currentId, fileId] of chosen) {
      if (fileId === null) out.set(currentId, null);
      else if (found.has(fileId)) out.set(currentId, found.get(fileId)!);
    }
    return out;
  }

  private async resolveOne(e: ParsedEntry, kind: ContentKind): Promise<ContentRef | null> {
    if (kind === "datapack") return null;
    const versionId = e.versionRef !== null && CF_ID_RE.test(e.versionRef) ? e.versionRef : null;
    if (CF_ID_RE.test(e.projectRef)) return { projectId: e.projectRef, versionId };
    if (!SLUG_RE.test(e.projectRef)) return null;
    const refKey = `${kind}:${e.projectRef}`;
    const stored = this.repo.get("curseforge", "ref", refKey)?.data;
    if (typeof stored === "string") return { projectId: stored, versionId };
    const params = new URLSearchParams({ gameId: String(CF_GAME_ID), classId: String(classOf(kind)), slug: e.projectRef });
    const r = await this.get({ url: `${API}/mods/search?${params}`, ttlMs: PROJECT_TTL }, searchSchema);
    const hit = r.data.data.find((m) => m.slug === e.projectRef);
    const projectId = hit ? cfId(hit.id) : null;
    if (!projectId) return null;
    this.repo.put("curseforge", "ref", refKey, projectId);
    return { projectId, versionId };
  }

  /** POST /v1/mods for ≤ 100 ids (cached per id set). */
  private async modsBatch(ids: string[]): Promise<ModDoc[]> {
    return (await this.get({
      url: `${API}/mods`, method: "POST", body: { modIds: ids.map(Number), filterPcOnly: true },
      cacheKey: `curseforge mods ${ids.join(",")}`, ttlMs: PROJECT_TTL,
    }, modsDoc)).data.data;
  }

  async pack(projectId: string, versionId: string): Promise<PackInfoDto> {
    const notFound = "Version not found on CurseForge";
    const id = this.id(projectId);
    if (!CF_ID_RE.test(versionId)) throw new HttpError(404, notFound);
    const stored = this.repo.get("curseforge", "pack", versionId)?.data as PackInfoDto | undefined;
    if (stored && stored.projectId === id) return stored;

    const file = (await this.get({ url: `${API}/mods/${id}/files/${versionId}`, ttlMs: VERSIONS_TTL }, fileDoc, notFound)).data.data;
    if (String(file.modId) !== id) throw new HttpError(404, notFound);
    const m = await this.mod(id);
    const split = splitGameVersions(file.gameVersions);
    const base = {
      platform: "curseforge" as const, projectId: id, slug: m.slug, versionId, name: m.name, versionLabel: file.displayName,
      iconUrl: proxiedImage(m.logo?.thumbnailUrl),
    };
    const unknown = (reason: string): PackInfoDto => {
      const info: PackInfoDto = {
        ...base,
        minecraftVersion: split.gameVersions.length === 1 ? split.gameVersions[0]! : null,
        loader: split.loaders.length === 1 && PACK_LOADERS.has(split.loaders[0]!) ? (split.loaders[0] as PackInfoDto["loader"]) : null,
        loaderVersion: null, contents: [], contentsKnown: false, reason,
      };
      this.repo.put("curseforge", "pack", versionId, info);
      return info;
    };

    if (!file.downloadUrl || m.allowModDistribution === false) return unknown(NOT_DISTRIBUTABLE);
    let zip: Buffer;
    try {
      // The key never goes to the CDN: `bytes` sends no credentials.
      zip = (await this.http.bytes(file.downloadUrl, { hosts: DOWNLOAD_HOSTS, maxBytes: PACK_MAX_BYTES, timeoutMs: PACK_TIMEOUT_MS, maxRedirects: 3 })).data;
    } catch (e) {
      if (e instanceof UpstreamError && e.message === TOO_LARGE) return unknown(PACK_TOO_LARGE);
      if (e instanceof UpstreamError && ["origin not allowed", "redirect not allowed", "too many redirects"].includes(e.message)) {
        return unknown(PACK_UNREADABLE);
      }
      return this.fail(e); // transient: not stored
    }
    let manifest;
    try {
      manifest = readCurseForgeManifest(zip);
    } catch {
      return unknown(PACK_UNREADABLE);
    }
    const contents = [...new Set(manifest.files.flatMap((f) => { const p = cfId(f.projectId); return p && p !== id ? [p] : []; }))]
      .map((p) => ({ platform: "curseforge" as const, projectId: p }));
    let loader: PackInfoDto["loader"] = null;
    let loaderVersion: string | null = null;
    if (manifest.loaderId) {
      const i = manifest.loaderId.indexOf("-");
      const name = (i < 0 ? manifest.loaderId : manifest.loaderId.slice(0, i)).toLowerCase();
      if (PACK_LOADERS.has(name)) {
        loader = name as PackInfoDto["loader"];
        loaderVersion = i < 0 ? null : manifest.loaderId.slice(i + 1) || null;
      }
    }
    const info: PackInfoDto = { ...base, minecraftVersion: manifest.minecraftVersion, loader, loaderVersion, contents, contentsKnown: true, reason: null };
    this.repo.put("curseforge", "pack", versionId, info);
    return info;
  }

  // ── helpers ──

  private async mod(id: string): Promise<ModDoc> {
    return (await this.get({ url: `${API}/mods/${id}`, ttlMs: PROJECT_TTL }, modDoc, "Project not found on CurseForge")).data.data;
  }

  private store(files: FileDoc[]): ContentVersionDto[] {
    return files.flatMap((f) => {
      const v = versionOf(f);
      if (v) this.repo.put("curseforge", "version", v.versionId, v);
      return v ? [v] : [];
    });
  }

  private id(projectId: string): string {
    this.headers();
    if (!CF_ID_RE.test(projectId)) throw new HttpError(400, "Invalid project id");
    return projectId;
  }

  /** The key header, read now; without a key, 409 before any request. */
  private headers(): Record<string, string> {
    const key = this.key();
    if (!key) throw new HttpError(409, NO_KEY_MESSAGE);
    return { "x-api-key": key };
  }

  private async get<T>(req: Omit<JsonRequest, "headers">, schema: z.ZodType<T>, notFound?: string): Promise<{ data: T; stale: boolean }> {
    const headers = this.headers();
    try {
      return await this.http.json({ ...req, headers }, schema);
    } catch (e) {
      return this.fail(e, notFound);
    }
  }

  private fail(e: unknown, notFound?: string): never {
    if (e instanceof HttpError) throw e;
    if (e instanceof UpstreamError) {
      if (e.status === 401 || e.status === 403) throw new HttpError(502, CURSEFORGE_KEY_REJECTED);
      if (e.status === 429) throw new HttpError(502, CURSEFORGE_RATE_LIMITED);
      if (e.status === 404 && notFound) throw new HttpError(404, notFound);
      throw new HttpError(502, CURSEFORGE_FAILED);
    }
    throw e;
  }
}

function classOf(kind: ContentKind): number {
  if (kind === "datapack") throw new HttpError(400, "CurseForge datapacks are not supported");
  return CF_CLASS_ID[kind];
}

function hitOf(m: ModDoc, projectId: string) {
  return {
    platform: "curseforge" as const, projectId, slug: m.slug, name: m.name, author: m.authors?.[0]?.name ?? "",
    summary: m.summary ?? "", iconUrl: proxiedImage(m.logo?.thumbnailUrl), downloads: m.downloadCount,
    categories: (m.categories ?? []).map((c) => c.name),
  };
}

function metaOf(m: ModDoc, projectId: string): ProjectMeta {
  return {
    projectId, slug: m.slug, name: m.name, author: m.authors?.[0]?.name ?? "", iconUrl: proxiedImage(m.logo?.thumbnailUrl),
    clientOnly: false, distributable: m.allowModDistribution !== false,
  };
}

/** CurseForge mixes Minecraft versions, loaders and sides ("Server", "Client", "Java 21") in `gameVersions`. */
export function splitGameVersions(all: readonly string[]): { gameVersions: string[]; loaders: string[] } {
  const gameVersions: string[] = [];
  const loaders: string[] = [];
  for (const v of all) {
    const lower = v.toLowerCase();
    if (GAME_VERSION_RE.test(v) || SNAPSHOT_RE.test(v)) gameVersions.push(v);
    else if (LOADER_NAMES.has(lower)) loaders.push(lower);
  }
  return { gameVersions: [...new Set(gameVersions)], loaders: [...new Set(loaders)] };
}

function versionOf(f: FileDoc): ContentVersionDto | null {
  const versionId = cfId(f.id);
  const projectId = cfId(f.modId);
  const publishedAt = isoDate(f.fileDate);
  if (!versionId || !projectId || !publishedAt) return null;
  const dependencies = (f.dependencies ?? []).flatMap((d): ContentDependencyDto[] => {
    const type = RELATION[d.relationType];
    const pid = cfId(d.modId);
    return type && pid ? [{ projectId: pid, versionId: null, type }] : [];
  });
  const installable = !!f.downloadUrl;
  return {
    platform: "curseforge", projectId, versionId, label: f.displayName, type: RELEASE_TYPE[f.releaseType], publishedAt,
    ...splitGameVersions(f.gameVersions), dependencies, installable, reason: installable ? null : NOT_DISTRIBUTABLE,
  };
}
