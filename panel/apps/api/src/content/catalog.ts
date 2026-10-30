import {
  CONTENT_LISTS, formatContentEntry, parseContentEntry, pickLatest, type ContentEntryMetaDto, type ContentPlatform,
  type ContentVersionDto, type LookupRequest, type ResolveRequest, type ResolveResultDto, type UpdateDto, type UpdatesRequest,
} from "@mcsm/shared";
import type { Timers } from "../files/stream.js";
import { HttpError } from "../lib/http.js";
import type { ContentAdapter, ProjectMeta } from "./adapter.js";
import { CurseForgeAdapter, NO_KEY_MESSAGE } from "./curseforge.js";
import { UpstreamClient, type ContentFetch } from "./http.js";
import { ImageProxy } from "./image.js";
import { ModrinthAdapter } from "./modrinth.js";
import type { ContentMetaRepo } from "./repo.js";
import { compatibleWith, resolveSelection, type ResolveDeps } from "./resolve.js";

/** Metadata rows older than this are purged when the panel starts (they are fetched again when needed). */
export const META_MAX_AGE_MS = 90 * 24 * 3_600_000;

export interface ContentCatalogOptions {
  repo: ContentMetaRepo;
  /** Read at call time (`app.curseforge.get()`); never logged nor returned. */
  curseforgeKey: () => string | null;
  fetch?: ContentFetch;
  now?: () => number;
  timers?: Timers;
  onError?: (url: string, err: unknown) => void;
}

type Ref = { projectId: string; versionId: string | null } | null;

/**
 * Content browser service (`app.content`): the Modrinth and CurseForge adapters, the installed-list lookup (served
 * from the metadata cache first, so it survives an upstream outage), dependency resolution, update checks and the
 * image proxy.
 */
export class ContentCatalog {
  private readonly adapters: Record<ContentPlatform, ContentAdapter>;
  private readonly images: ImageProxy;
  private readonly repo: ContentMetaRepo;
  private readonly now: () => number;
  private readonly curseforgeKey: () => string | null;

  constructor(opts: ContentCatalogOptions) {
    this.repo = opts.repo;
    this.now = opts.now ?? Date.now;
    this.curseforgeKey = opts.curseforgeKey;
    const http = new UpstreamClient({ fetch: opts.fetch, now: this.now, timers: opts.timers, onError: opts.onError });
    this.adapters = {
      modrinth: new ModrinthAdapter(http, opts.repo),
      curseforge: new CurseForgeAdapter(http, opts.repo, opts.curseforgeKey),
    };
    this.images = new ImageProxy(http, this.now);
  }

  adapter(p: ContentPlatform): ContentAdapter {
    return this.adapters[p];
  }

  /** Metadata of spec entries, in order. Never throws for one entry: what cannot be resolved comes back `resolved: false`. */
  async lookup(items: LookupRequest["entries"]): Promise<ContentEntryMetaDto[]> {
    const out: ContentEntryMetaDto[] = items.map((i) => unresolved(i.list, i.entry));
    for (const platform of ["modrinth", "curseforge"] as const) {
      const idx = items.flatMap((it, i) => (CONTENT_LISTS[it.list].platform === platform ? [i] : []));
      if (idx.length === 0) continue;
      const adapter = this.adapters[platform];
      // Pinned entries carry their ids; raw ones are resolved in batches per kind (a failure leaves them unresolved).
      const refs: Ref[] = idx.map((i) => {
        const parsed = parseContentEntry(platform, items[i]!.entry);
        return parsed.pinned ? { projectId: parsed.projectRef, versionId: parsed.versionRef } : null;
      });
      for (const kind of new Set(idx.map((i) => CONTENT_LISTS[items[i]!.list].kind))) {
        const raw = idx.flatMap((i, k) => {
          const parsed = parseContentEntry(platform, items[i]!.entry);
          return !parsed.pinned && CONTENT_LISTS[items[i]!.list].kind === kind ? [{ k, parsed }] : [];
        });
        if (raw.length === 0) continue;
        const resolved = (await quiet(adapter.resolveRefs(raw.map((r) => r.parsed), kind))) ?? [];
        raw.forEach((r, j) => { refs[r.k] = resolved[j] ?? null; });
      }
      const versions = await this.versionsFor(platform, refs.flatMap((r) => (r?.versionId ? [r.versionId] : [])));
      const metas = await this.metasFor(platform, refs.flatMap((r) => (r ? [r.projectId] : [])));
      idx.forEach((i, k) => {
        const ref = refs[k];
        if (!ref) return;
        const meta = metas.get(ref.projectId);
        const version = ref.versionId ? versions.get(ref.versionId) : undefined;
        if (!meta || (ref.versionId && (!version || version.projectId !== ref.projectId))) return;
        out[i] = {
          ...out[i]!, resolved: true, projectId: ref.projectId, versionId: ref.versionId, slug: meta.slug, name: meta.name,
          author: meta.author, iconUrl: meta.iconUrl, versionLabel: version?.label ?? null, versionType: version?.type ?? null,
          gameVersions: version?.gameVersions ?? [], loaders: version?.loaders ?? [], dependencies: version?.dependencies ?? [],
        };
      });
    }
    return out;
  }

  async resolve(req: ResolveRequest): Promise<ResolveResultDto> {
    const { platform, kind } = CONTENT_LISTS[req.list];
    if (platform === "curseforge" && !this.curseforgeKey()) throw new HttpError(409, NO_KEY_MESSAGE);
    const adapter = this.adapters[platform];

    const present = new Map<string, { versionId: string | null; dependencies: ContentVersionDto["dependencies"] }>();
    for (const m of await this.lookup(req.present)) {
      if (m.resolved && m.projectId && CONTENT_LISTS[m.list].platform === platform) {
        present.set(m.projectId, { versionId: m.versionId, dependencies: m.dependencies });
      }
    }
    let inPack = new Set<string>();
    if (req.pack && req.pack.platform === platform) {
      const info = await quiet(adapter.pack(req.pack.projectId, req.pack.versionId));
      if (info) inPack = new Set(info.contents.filter((c) => c.platform === platform).map((c) => c.projectId));
    }

    const deps: ResolveDeps = {
      version: async (id) => (await this.versionsFor(platform, [id])).get(id) ?? null,
      latest: async (pid) => {
        const r = await quiet(adapter.versions(pid, { kind, gameVersion: req.target.gameVersion, loaders: req.target.loaders }));
        return r ? pickLatest(r.versions.filter((v) => v.installable && compatibleWith(v, req.target)), null) : null;
      },
      name: async (pid) => (await this.metasFor(platform, [pid])).get(pid)?.name ?? pid,
    };
    return resolveSelection({ list: req.list, selections: req.selections, present, inPack, target: req.target }, deps);
  }

  /**
   * Per entry: whether its pinned version fits the target and the newest version it may move to, from one batched
   * request per ≤ 100 entries. An entry the source could not be asked about comes back `checked: false` (its `latest`
   * is unknown, not "up to date"). An unpinned entry follows the newest compatible version on its own: nothing to check.
   */
  async updates(req: UpdatesRequest): Promise<UpdateDto[]> {
    const { platform, kind } = CONTENT_LISTS[req.list];
    const metas = await this.lookup(req.entries.map((entry) => ({ list: req.list, entry })));
    const pinned = [...new Set(metas.flatMap((m) => (m.resolved && m.versionId ? [m.versionId] : [])))];
    const currents = await this.versionsFor(platform, pinned);
    const latest = (await quiet(this.adapters[platform].latestFor(
      pinned.flatMap((id) => { const v = currents.get(id); return v ? [v] : []; }),
      { kind, gameVersion: req.target.gameVersion, loaders: req.target.loaders },
    ))) ?? new Map<string, ContentVersionDto | null>();
    return metas.map((m): UpdateDto => {
      const base = { entry: m.raw, projectId: m.projectId, currentVersionId: m.versionId };
      if (!m.resolved || !m.projectId) return { ...base, projectId: null, currentVersionId: null, compatible: true, checked: false, latest: null };
      if (m.versionId === null) return { ...base, compatible: true, checked: true, latest: null };
      const compatible = compatibleWith(m, req.target);
      if (!latest.has(m.versionId)) return { ...base, compatible, checked: false, latest: null };
      const v = latest.get(m.versionId) ?? null;
      const current = currents.get(m.versionId);
      const offer = v !== null && v.versionId !== m.versionId && v.installable && compatibleWith(v, req.target)
        && (!compatible || !current || v.publishedAt > current.publishedAt);
      return {
        ...base, compatible, checked: true,
        latest: offer ? { versionId: v.versionId, label: v.label, type: v.type, entry: formatContentEntry(platform, m.projectId, v.versionId) } : null,
      };
    });
  }

  image(url: string): Promise<{ data: Buffer; contentType: string }> {
    return this.images.get(url);
  }

  purge(): number {
    return this.repo.purgeOlderThan(new Date(this.now() - META_MAX_AGE_MS).toISOString());
  }

  /** Versions from the repo, then the source for the missing ones (a failure leaves them missing). */
  private async versionsFor(platform: ContentPlatform, ids: string[]): Promise<Map<string, ContentVersionDto>> {
    const out = new Map<string, ContentVersionDto>();
    for (const [id, row] of this.repo.getMany(platform, "version", ids)) out.set(id, row.data as ContentVersionDto);
    const missing = [...new Set(ids.filter((id) => !out.has(id)))];
    if (missing.length > 0) for (const v of (await quiet(this.adapters[platform].versionsByIds(missing))) ?? []) out.set(v.versionId, v);
    return out;
  }

  private async metasFor(platform: ContentPlatform, ids: string[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    for (const [id, row] of this.repo.getMany(platform, "project", ids)) out.set(id, row.data as ProjectMeta);
    const missing = [...new Set(ids.filter((id) => !out.has(id)))];
    if (missing.length > 0) for (const m of (await quiet(this.adapters[platform].projects(missing))) ?? []) out.set(m.projectId, m);
    return out;
  }
}

function unresolved(list: ContentEntryMetaDto["list"], raw: string): ContentEntryMetaDto {
  return {
    list, raw, resolved: false, projectId: null, versionId: null, slug: null, name: null, author: null, iconUrl: null,
    versionLabel: null, versionType: null, gameVersions: [], loaders: [], dependencies: [],
  };
}

/** The value, or null when the source fails (the adapters already turned the failure into an English HttpError). */
async function quiet<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}
