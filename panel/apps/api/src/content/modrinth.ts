import { createHash } from "node:crypto";
import {
  MODRINTH_ID_RE, type ContentCategoryDto, type ContentDependencyDto, type ContentKind, type ContentProjectDto,
  type ContentSearchDto, type ContentVersionDto, type PackInfoDto, type ParsedEntry,
} from "@mcsm/shared";
import { z } from "zod";
import { HttpError } from "../lib/http.js";
import { UpstreamError } from "../versions/sources.js";
import {
  PACK_MAX_BYTES, PACK_TIMEOUT_MS, PACK_TOO_LARGE, PACK_UNREADABLE, SEARCH_LIMIT, chunks, isoDate, newestFirst, proxiedImage,
  ALLOWED_CHANNELS, REF_UNAVAILABLE, type ContentAdapter, type ContentRef, type RefResult, type ProjectMeta, type SearchInput, type VersionFilter,
} from "./adapter.js";
import { DOWNLOAD_HOSTS, RATE_BUDGET_EXHAUSTED, TOO_LARGE, type JsonResult, type UpstreamClient } from "./http.js";
import { loaderOf, readMrpackIndex } from "./pack.js";
import type { ContentMetaRepo, MetaPut } from "./repo.js";
import { descriptionHtml } from "./sanitize.js";

const API = "https://api.modrinth.com/v2";

const SEARCH_TTL = 300_000;
const CATEGORIES_TTL = 24 * 3_600_000;
const PROJECT_TTL = 3_600_000;
const VERSIONS_TTL = 15 * 60_000;

export const MODRINTH_RATE_LIMITED = "Modrinth is rate limiting the panel: try again in a minute";
export const MODRINTH_FAILED = "Could not query Modrinth";
export const MODRINTH_BUDGET_SPENT = "Modrinth rate limit reached, try again in a minute";

// ── Upstream documents (only what is used; zod drops the rest) ──

const date = z.string().refine((s) => isoDate(s) !== null, "invalid date");

const hitSchema = z.object({
  project_id: z.string(),
  slug: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  author: z.string().nullish(),
  downloads: z.number(),
  categories: z.array(z.string()).nullish(),
  icon_url: z.string().nullish(),
  server_side: z.string().nullish(),
});
const searchSchema = z.object({ hits: z.array(hitSchema), offset: z.number(), limit: z.number(), total_hits: z.number() });

const tagsSchema = z.array(z.object({ name: z.string(), project_type: z.string(), header: z.string() }));

const projectSchema = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  project_type: z.string().nullish(),
  team: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  body: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  downloads: z.number(),
  icon_url: z.string().nullish(),
  server_side: z.string().nullish(),
  source_url: z.string().nullish(),
  issues_url: z.string().nullish(),
  wiki_url: z.string().nullish(),
  discord_url: z.string().nullish(),
  gallery: z.array(z.object({ url: z.string() })).nullish(),
});
type ProjectDoc = z.infer<typeof projectSchema>;

const membersSchema = z.array(z.object({ team_id: z.string().nullish(), user: z.object({ username: z.string() }), role: z.string().nullish() }));
type MembersDoc = z.infer<typeof membersSchema>;

const versionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  version_number: z.string(),
  version_type: z.enum(["release", "beta", "alpha"]),
  date_published: date,
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()),
  dependencies: z.array(z.object({
    project_id: z.string().nullish(),
    version_id: z.string().nullish(),
    dependency_type: z.enum(["required", "optional", "incompatible", "embedded"]),
  })).nullish(),
  files: z.array(z.object({
    url: z.string(), primary: z.boolean().nullish(), hashes: z.object({ sha1: z.string().nullish() }).nullish(),
  })).nullish(),
});
type VersionDoc = z.infer<typeof versionSchema>;

const versionFilesSchema = z.record(z.string(), z.object({ project_id: z.string() }));

const SORT_INDEX = { relevance: "relevance", downloads: "downloads", newest: "newest", updated: "updated" } as const;
const PAGE_TYPES = new Set(["mod", "modpack", "plugin", "datapack", "resourcepack", "shader"]);
const PACK_LOADERS = new Set<string>(["fabric", "forge", "neoforge", "quilt"]);
/** A project slug, id or version number usable as one path segment (never `.`/`..`). */
const SEGMENT_RE = /^(?!\.+$)[A-Za-z0-9_.+-]{1,128}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

const enc = encodeURIComponent;
const json = (v: unknown) => JSON.stringify(v);
const modrinthId = (s: string | null | undefined): string | null => (s && MODRINTH_ID_RE.test(s) ? s : null);
const label = (name: string) => {
  const s = name.replaceAll("-", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const safeLink = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

export class ModrinthAdapter implements ContentAdapter {
  readonly platform = "modrinth" as const;

  constructor(private readonly http: UpstreamClient, private readonly repo: ContentMetaRepo) {}

  async search(q: SearchInput): Promise<ContentSearchDto> {
    const facets: string[][] = [[`project_type:${q.kind}`]];
    if (q.loaders.length > 0) facets.push(q.loaders.map((l) => `categories:${l}`));
    if (q.gameVersion !== null) facets.push([`versions:${q.gameVersion}`]);
    facets.push(["server_side!=unsupported"]);
    if (q.category !== null) facets.push([`categories:${q.category}`]);
    const params = new URLSearchParams({
      query: q.q, facets: json(facets), index: SORT_INDEX[q.sort], offset: String(q.offset), limit: String(SEARCH_LIMIT),
    });
    const r = await this.get({ url: `${API}/search?${params}`, ttlMs: SEARCH_TTL }, searchSchema);
    const hits = r.data.hits.flatMap((h) => {
      const projectId = modrinthId(h.project_id);
      // The facet already excludes them; a hit that slips through is dropped anyway.
      if (!projectId || h.server_side === "unsupported") return [];
      return [{
        platform: "modrinth" as const, projectId, slug: h.slug ?? projectId, name: h.title, author: h.author ?? "",
        summary: h.description ?? "", iconUrl: proxiedImage(h.icon_url), downloads: h.downloads, categories: h.categories ?? [],
      }];
    });
    return { hits, total: r.data.total_hits, offset: r.data.offset, limit: r.data.limit, stale: r.stale };
  }

  async categories(kind: ContentKind): Promise<ContentCategoryDto[]> {
    const r = await this.get({ url: `${API}/tag/category`, ttlMs: CATEGORIES_TTL }, tagsSchema);
    const type = kind === "modpack" ? "modpack" : "mod";
    return r.data.filter((t) => t.header === "categories" && t.project_type === type).map((t) => ({ id: t.name, label: label(t.name) }));
  }

  async project(projectId: string): Promise<ContentProjectDto> {
    const { data: doc, fresh } = await this.projectDoc(projectId);
    const id = modrinthId(doc.id);
    if (!id) throw new HttpError(502, MODRINTH_FAILED);
    let author = "";
    try {
      author = ownerOf((await this.http.json({ url: `${API}/project/${enc(id)}/members`, ttlMs: PROJECT_TTL }, membersSchema)).data);
    } catch { /* the author is cosmetic: the project still shows */ }
    const meta = metaOf(doc, id, author);
    if (fresh) this.repo.put("modrinth", "project", id, meta);
    const links = ([["Source", doc.source_url], ["Issues", doc.issues_url], ["Wiki", doc.wiki_url], ["Discord", doc.discord_url]] as const)
      .flatMap(([l, u]) => { const url = safeLink(u); return url ? [{ label: l, url }] : []; });
    const type = doc.project_type && PAGE_TYPES.has(doc.project_type) ? doc.project_type : "project";
    return {
      platform: "modrinth", projectId: id, slug: meta.slug, name: doc.title, author, summary: doc.description ?? "",
      iconUrl: meta.iconUrl, downloads: doc.downloads, categories: doc.categories ?? [],
      descriptionHtml: descriptionHtml({ markdown: doc.body ?? "" }),
      gallery: (doc.gallery ?? []).flatMap((g) => { const u = proxiedImage(g.url); return u ? [u] : []; }),
      links, pageUrl: `https://modrinth.com/${type}/${enc(meta.slug)}`, clientOnly: meta.clientOnly, distributable: true,
    };
  }

  async projects(ids: string[]): Promise<ProjectMeta[]> {
    const wanted = [...new Set(ids.filter((id) => SEGMENT_RE.test(id)))];
    const docs: { d: ProjectDoc; fresh: boolean }[] = [];
    for (const part of chunks(wanted)) {
      const r = await this.get({ url: `${API}/projects?${new URLSearchParams({ ids: json(part) })}`, ttlMs: PROJECT_TTL }, z.array(projectSchema));
      docs.push(...r.data.map((d) => ({ d, fresh: r.fresh })));
    }
    const owners = await this.owners(docs.flatMap(({ d }) => (d.team && MODRINTH_ID_RE.test(d.team) ? [d.team] : [])));
    const rows: MetaPut[] = [];
    const out = docs.flatMap(({ d, fresh }) => {
      const id = modrinthId(d.id);
      if (!id) return [];
      const meta = metaOf(d, id, (d.team && owners.get(d.team)) ?? "");
      if (fresh) rows.push({ kind: "project", id, data: meta });
      return [meta];
    });
    this.repo.putMany("modrinth", rows);
    return out;
  }

  async versions(projectId: string, f: VersionFilter): Promise<{ versions: ContentVersionDto[]; stale: boolean }> {
    const loaders = f.kind === "datapack" ? ["datapack"] : f.loaders;
    const params = new URLSearchParams();
    if (loaders.length > 0) params.set("loaders", json(loaders));
    if (f.gameVersion !== null) params.set("game_versions", json([f.gameVersion]));
    params.set("include_changelog", "false");
    const r = await this.get(
      { url: `${API}/project/${enc(this.segment(projectId))}/version?${params}`, ttlMs: VERSIONS_TTL },
      z.array(versionSchema),
      "Project not found on Modrinth",
    );
    return { versions: this.versionsOf(r, newestFirst), stale: r.stale };
  }

  async versionsByIds(ids: string[]): Promise<ContentVersionDto[]> {
    const wanted = [...new Set(ids.filter((id) => MODRINTH_ID_RE.test(id)))];
    const out: ContentVersionDto[] = [];
    for (const part of chunks(wanted)) {
      const r = await this.get({ url: `${API}/versions?${new URLSearchParams({ ids: json(part) })}`, ttlMs: VERSIONS_TTL }, z.array(versionSchema));
      out.push(...this.versionsOf(r));
    }
    return out;
  }

  async resolveRefs(es: ParsedEntry[], _kind: ContentKind): Promise<RefResult[]> {
    // Project refs (slugs or ids): the metadata cache first, then /v2/projects?ids= in batches (it accepts slugs).
    const ids = new Map<string, string>();
    const unknown = new Set<string>();
    let down = false;
    for (const e of es) {
      if (!SEGMENT_RE.test(e.projectRef)) continue;
      const stored = this.storedRef(e.projectRef);
      if (stored) ids.set(e.projectRef, stored);
      else unknown.add(e.projectRef);
    }
    if (unknown.size > 0) {
      let metas: ProjectMeta[] = [];
      try {
        metas = await this.projects([...unknown]);
      } catch {
        down = true; // the source failed: these entries are unavailable, not unknown
      }
      const refs: MetaPut[] = [];
      for (const ref of unknown) {
        const lower = ref.toLowerCase();
        const m = metas.find((x) => x.projectId === ref || x.slug.toLowerCase() === lower);
        if (!m) continue;
        ids.set(ref, m.projectId);
        refs.push({ kind: "ref", id: ref, data: m.projectId });
      }
      this.repo.putMany("modrinth", refs);
    }
    const out: RefResult[] = [];
    for (const e of es) {
      const projectId = ids.get(e.projectRef);
      if (!projectId) { out.push(down && unknown.has(e.projectRef) ? REF_UNAVAILABLE : null); continue; }
      if (e.versionRef === null || !SEGMENT_RE.test(e.versionRef)) { out.push({ projectId, versionId: null }); continue; }
      // A version id is checked against its project by the lookup; a version number needs the project (one request, cached).
      if (MODRINTH_ID_RE.test(e.versionRef)) { out.push({ projectId, versionId: e.versionRef }); continue; }
      try {
        out.push({ projectId, versionId: await this.versionNumber(projectId, e.versionRef) });
      } catch {
        out.push(REF_UNAVAILABLE); // versionNumber answers null for a 404: anything thrown is the source failing
      }
    }
    return out;
  }

  async latestFor(current: ContentVersionDto[], f: VersionFilter): Promise<Map<string, ContentVersionDto | null>> {
    const out = new Map<string, ContentVersionDto | null>();
    const loaders = f.kind === "datapack" ? ["datapack"] : f.loaders;
    if (f.gameVersion === null || loaders.length === 0) return out; // the endpoint needs both: nothing can be checked
    const ids = [...new Set(current.map((v) => v.versionId))];
    let files = this.repo.getMany("modrinth", "file", ids);
    const missing = ids.filter((id) => !files.has(id));
    if (missing.length > 0) {
      try {
        await this.versionsByIds(missing); // stores the hashes it finds
      } catch { /* left out below: not checked */ }
      files = this.repo.getMany("modrinth", "file", ids);
    }
    const sha1Of = (id: string) => { const d = files.get(id)?.data; return typeof d === "string" ? d : null; };
    for (const channel of ["release", "beta", "alpha"] as const) {
      const group = current.filter((v) => v.type === channel && sha1Of(v.versionId) !== null);
      const hashes = [...new Set(group.map((v) => sha1Of(v.versionId)!))];
      for (const part of chunks(hashes)) {
        const body = { hashes: part, algorithm: "sha1", loaders, game_versions: [f.gameVersion], version_types: [...ALLOWED_CHANNELS[channel]] };
        let r: JsonResult<Record<string, VersionDoc>>;
        try {
          r = await this.get({
            url: `${API}/version_files/update`, method: "POST", body,
            cacheKey: `modrinth update ${createHash("sha1").update(JSON.stringify(body)).digest("hex")}`, ttlMs: VERSIONS_TTL,
          }, z.record(z.string(), versionSchema));
        } catch {
          continue; // not checked
        }
        const byHash = r.data;
        const mapped = new Map(this.versionsOf({ data: Object.values(byHash), fresh: r.fresh }).map((v) => [v.versionId, v]));
        const inPart = new Set(part);
        for (const v of group) {
          const h = sha1Of(v.versionId)!;
          if (!inPart.has(h)) continue;
          const doc = byHash[h];
          out.set(v.versionId, doc ? mapped.get(doc.id) ?? null : null);
        }
      }
    }
    return out;
  }

  /** Version id of a version number of the project (null when the source does not know it); cached as a ref. */
  private async versionNumber(projectId: string, number: string): Promise<string | null> {
    const refKey = `${projectId}:${number}`;
    const stored = this.storedRef(refKey);
    if (stored) return stored;
    const r = await this.orNull(() =>
      this.get({ url: `${API}/project/${enc(projectId)}/version/${enc(number)}`, ttlMs: VERSIONS_TTL }, versionSchema, "Version not found on Modrinth"));
    const v = r && r.data.project_id === projectId ? this.versionsOf({ data: [r.data], fresh: r.fresh })[0] : undefined;
    if (!v) return null;
    this.repo.put("modrinth", "ref", refKey, v.versionId);
    return v.versionId;
  }

  async pack(projectId: string, versionId: string): Promise<PackInfoDto> {
    const notFound = "Version not found on Modrinth";
    if (!MODRINTH_ID_RE.test(projectId) || !MODRINTH_ID_RE.test(versionId)) throw new HttpError(404, notFound);
    const stored = this.repo.get("modrinth", "pack", versionId)?.data as PackInfoDto | undefined;
    if (stored && stored.projectId === projectId) return stored;

    const v = (await this.get({ url: `${API}/version/${enc(versionId)}`, ttlMs: VERSIONS_TTL }, versionSchema, notFound)).data;
    if (v.project_id !== projectId) throw new HttpError(404, notFound);
    const p = (await this.projectDoc(projectId)).data;
    const base = {
      platform: "modrinth" as const, projectId, slug: p.slug ?? projectId, versionId, name: p.title,
      versionLabel: v.version_number, iconUrl: proxiedImage(p.icon_url),
    };
    const unknown = (reason: string): PackInfoDto => {
      const info: PackInfoDto = {
        ...base,
        minecraftVersion: v.game_versions.length === 1 ? v.game_versions[0]! : null,
        loader: v.loaders.length === 1 && PACK_LOADERS.has(v.loaders[0]!) ? (v.loaders[0] as PackInfoDto["loader"]) : null,
        loaderVersion: null, contents: [], contentsKnown: false, reason,
      };
      this.repo.put("modrinth", "pack", versionId, info);
      return info;
    };

    const file = (v.files ?? []).find((f) => f.primary) ?? v.files?.[0];
    if (!file) return unknown(PACK_UNREADABLE);
    let zip: Buffer;
    try {
      zip = (await this.http.bytes(file.url, { hosts: DOWNLOAD_HOSTS, maxBytes: PACK_MAX_BYTES, timeoutMs: PACK_TIMEOUT_MS, maxRedirects: 3 })).data;
    } catch (e) {
      if (e instanceof UpstreamError && e.message === TOO_LARGE) return unknown(PACK_TOO_LARGE);
      if (isRefusedUrl(e)) return unknown(PACK_UNREADABLE);
      return this.fail(e); // transient: not stored
    }
    let index;
    try {
      index = readMrpackIndex(zip);
    } catch {
      return unknown(PACK_UNREADABLE);
    }
    const hashes = [...new Set(index.files.filter((f) => f.server !== "unsupported").map((f) => f.sha1))];
    const byHash = hashes.length === 0 ? {} : (await this.get({
      url: `${API}/version_files`, method: "POST", body: { hashes, algorithm: "sha1" },
      cacheKey: `modrinth version_files ${versionId}`, ttlMs: PROJECT_TTL,
    }, versionFilesSchema)).data;
    const contents = [...new Set(hashes.flatMap((h) => {
      const id = modrinthId(byHash[h]?.project_id);
      return id && id !== projectId ? [id] : [];
    }))].map((id) => ({ platform: "modrinth" as const, projectId: id }));
    const { loader, version } = loaderOf(index.dependencies);
    const info: PackInfoDto = {
      ...base, minecraftVersion: index.dependencies.minecraft ?? null, loader, loaderVersion: version,
      contents, contentsKnown: true, reason: null,
    };
    this.repo.put("modrinth", "pack", versionId, info);
    return info;
  }

  // ── helpers ──

  private projectDoc(ref: string): Promise<JsonResult<ProjectDoc>> {
    return this.get({ url: `${API}/project/${enc(this.segment(ref))}`, ttlMs: PROJECT_TTL }, projectSchema, "Project not found on Modrinth");
  }

  /** Owner username per team id (best effort: a failure leaves the authors empty). */
  private async owners(teams: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunks([...new Set(teams)])) {
      try {
        const r = await this.http.json({ url: `${API}/teams?${new URLSearchParams({ ids: json(part) })}`, ttlMs: PROJECT_TTL }, z.array(membersSchema));
        for (const members of r.data) {
          const team = members[0]?.team_id;
          if (team) out.set(team, ownerOf(members));
        }
      } catch { /* cosmetic */ }
    }
    return out;
  }

  /**
   * Maps versions and keeps the ones `keep` returns. A document just downloaded (`fresh`) stores what is kept, with each
   * one's primary-file sha1, in one transaction; a copy from the memory cache was stored when it was downloaded.
   */
  private versionsOf(
    r: { data: VersionDoc[]; fresh: boolean },
    keep: (vs: ContentVersionDto[]) => ContentVersionDto[] = (vs) => vs,
  ): ContentVersionDto[] {
    const sha1s = new Map<string, string>();
    const vs = keep(r.data.flatMap((d) => {
      const v = versionOf(d);
      if (!v) return [];
      const file = (d.files ?? []).find((x) => x.primary) ?? d.files?.[0];
      const sha1 = file?.hashes?.sha1?.toLowerCase();
      if (sha1 && SHA1_RE.test(sha1)) sha1s.set(v.versionId, sha1);
      return [v];
    }));
    if (r.fresh) {
      this.repo.putMany("modrinth", vs.flatMap((v): MetaPut[] => {
        const sha1 = sha1s.get(v.versionId);
        return [{ kind: "version", id: v.versionId, data: v }, ...(sha1 ? [{ kind: "file" as const, id: v.versionId, data: sha1 }] : [])];
      }));
    }
    return vs;
  }

  private storedRef(key: string): string | null {
    const data = this.repo.get("modrinth", "ref", key)?.data;
    return typeof data === "string" ? data : null;
  }

  private segment(s: string): string {
    if (!SEGMENT_RE.test(s)) throw new HttpError(400, "Invalid project id");
    return s;
  }

  /** null when the source says 404; any other failure is thrown. */
  private async orNull<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  private async get<T>(req: Parameters<UpstreamClient["json"]>[0], schema: z.ZodType<T>, notFound?: string): Promise<JsonResult<T>> {
    try {
      return await this.http.json(req, schema);
    } catch (e) {
      return this.fail(e, notFound);
    }
  }

  private fail(e: unknown, notFound?: string): never {
    if (e instanceof HttpError) throw e;
    if (e instanceof UpstreamError) {
      if (e.status === 429) throw new HttpError(502, MODRINTH_RATE_LIMITED);
      if (e.message === RATE_BUDGET_EXHAUSTED) throw new HttpError(502, MODRINTH_BUDGET_SPENT);
      if (e.status === 404 && notFound) throw new HttpError(404, notFound);
      throw new HttpError(502, MODRINTH_FAILED);
    }
    throw e;
  }
}

function isRefusedUrl(e: unknown): boolean {
  return e instanceof UpstreamError && ["origin not allowed", "redirect not allowed", "too many redirects"].includes(e.message);
}

function ownerOf(members: MembersDoc): string {
  return (members.find((m) => m.role === "Owner") ?? members[0])?.user.username ?? "";
}

function metaOf(d: ProjectDoc, id: string, author: string): ProjectMeta {
  return {
    projectId: id, slug: d.slug ?? id, name: d.title, author, iconUrl: proxiedImage(d.icon_url),
    clientOnly: d.server_side === "unsupported", distributable: true,
  };
}

function versionOf(d: VersionDoc): ContentVersionDto | null {
  const versionId = modrinthId(d.id);
  const projectId = modrinthId(d.project_id);
  const publishedAt = isoDate(d.date_published);
  if (!versionId || !projectId || !publishedAt) return null;
  const dependencies: ContentDependencyDto[] = (d.dependencies ?? []).map((x) => ({
    projectId: modrinthId(x.project_id), versionId: modrinthId(x.version_id), type: x.dependency_type,
  }));
  return {
    platform: "modrinth", projectId, versionId, label: d.version_number, type: d.version_type, publishedAt,
    gameVersions: d.game_versions, loaders: d.loaders, dependencies, installable: true, reason: null,
  };
}
