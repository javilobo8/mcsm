import { z } from "zod";
import { ENTRY_RE } from "./spec-content.js";
import { MAX_LIST_ITEMS } from "./spec-limits.js";
import { VERSION_QUERY_RE } from "./versions.js";

/** Content browser contract (mods, plugins, datapacks, modpacks): shared by the API and the web. */

export const CONTENT_PLATFORMS = ["modrinth", "curseforge"] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number];
export const CONTENT_KINDS = ["mod", "plugin", "datapack", "modpack"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const CONTENT_SORTS = ["relevance", "downloads", "newest", "updated"] as const;
export type ContentSort = (typeof CONTENT_SORTS)[number];

export const CF_GAME_ID = 432;
export const CF_CLASS_ID = { mod: 6, plugin: 5, modpack: 4471 } as const;
export const CF_MOD_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const;

export const MODRINTH_ID_RE = /^[A-Za-z0-9]{8}$/;
export const CF_ID_RE = /^[1-9][0-9]{0,11}$/;
export const CONTENT_LOADERS = ["fabric", "quilt", "forge", "neoforge", "paper", "purpur", "folia", "spigot", "bukkit", "datapack"] as const;
export type ContentLoader = (typeof CONTENT_LOADERS)[number];

// ── Spec lists a piece of content can live in ──

export type ContentSection = "mods" | "plugins" | "datapacks";
export interface ContentListInfo { platform: ContentPlatform; kind: ContentKind; section: ContentSection; field: string }

export const CONTENT_LISTS = {
  "mods.modrinthProjects": { platform: "modrinth", kind: "mod", section: "mods", field: "modrinthProjects" },
  "mods.curseforgeFiles": { platform: "curseforge", kind: "mod", section: "mods", field: "curseforgeFiles" },
  "plugins.modrinthProjects": { platform: "modrinth", kind: "plugin", section: "plugins", field: "modrinthProjects" },
  "plugins.curseforgeFiles": { platform: "curseforge", kind: "plugin", section: "plugins", field: "curseforgeFiles" },
  "datapacks.modrinthProjects": { platform: "modrinth", kind: "datapack", section: "datapacks", field: "modrinthProjects" },
} as const satisfies Record<string, ContentListInfo>;
export type ContentListKey = keyof typeof CONTENT_LISTS;
export const CONTENT_LIST_KEYS = Object.keys(CONTENT_LISTS) as [ContentListKey, ...ContentListKey[]];

/** The spec list that holds `kind` content from `platform` (null if there is none, e.g. CurseForge datapacks). */
export function listFor(platform: ContentPlatform, kind: ContentKind): ContentListKey | null {
  for (const key of CONTENT_LIST_KEYS) {
    const l = CONTENT_LISTS[key];
    if (l.platform === platform && l.kind === kind) return key;
  }
  return null;
}

// ── Entries ──

export interface ParsedEntry { raw: string; projectRef: string; versionRef: string | null; pinned: boolean }

const MODRINTH_PINNED_RE = /^[A-Za-z0-9]{8}:[A-Za-z0-9]{8}$/;
const CF_PINNED_RE = /^[1-9]\d{0,11}:[1-9]\d{0,11}$/;
const MODRINTH_PREFIXES = ["datapack:", "fabric:", "forge:", "paper:"];

/** Reads a spec entry. Only `id:id` is pinned; anything hand-typed keeps its raw pieces. */
export function parseContentEntry(platform: ContentPlatform, raw: string): ParsedEntry {
  const pinnedRe = platform === "modrinth" ? MODRINTH_PINNED_RE : CF_PINNED_RE;
  if (pinnedRe.test(raw)) {
    const i = raw.indexOf(":");
    return { raw, projectRef: raw.slice(0, i), versionRef: raw.slice(i + 1), pinned: true };
  }
  let rest = raw;
  if (platform === "modrinth") {
    const prefix = MODRINTH_PREFIXES.find((p) => rest.startsWith(p));
    if (prefix) rest = rest.slice(prefix.length);
  }
  const i = rest.indexOf(":");
  const project = i < 0 ? rest : rest.slice(0, i);
  const versionRef = i < 0 ? null : rest.slice(i + 1);
  return { raw, projectRef: project.replace(/\?$/, ""), versionRef, pinned: false };
}

export const formatContentEntry = (_platform: ContentPlatform, projectId: string, versionId: string): string => `${projectId}:${versionId}`;

// ── Targets ──

export interface ContentTarget { gameVersion: string; loaders: string[] }

const MODRINTH_MOD_LOADERS: Readonly<Record<string, string[]>> = {
  FABRIC: ["fabric"], QUILT: ["quilt", "fabric"], FORGE: ["forge"], NEOFORGE: ["neoforge"],
};
const MODRINTH_PLUGIN_LOADERS: Readonly<Record<string, string[]>> = {
  PAPER: ["paper", "spigot", "bukkit"], PURPUR: ["purpur", "paper", "spigot", "bukkit"], FOLIA: ["folia"], SPIGOT: ["spigot", "bukkit"],
};

/** Modrinth `loaders` facet values that fit a server of `type` for `kind` content. */
export function modrinthLoadersFor(type: string, kind: ContentKind, packLoader?: string | null): string[] {
  if (kind === "datapack") return ["datapack"];
  if (kind === "modpack") return [];
  if (kind === "mod" && (type === "MODRINTH" || type === "AUTO_CURSEFORGE")) {
    return packLoader ? modrinthLoadersFor(packLoader.toUpperCase(), "mod") : [];
  }
  const table = kind === "mod" ? MODRINTH_MOD_LOADERS : MODRINTH_PLUGIN_LOADERS;
  return Object.hasOwn(table, type) ? [...table[type]!] : [];
}

/** CurseForge `modLoaderType` for the first loader CurseForge knows. */
export function curseforgeLoaderFor(loaders: readonly string[]): number | null {
  for (const l of loaders) if (Object.hasOwn(CF_MOD_LOADER, l)) return CF_MOD_LOADER[l as keyof typeof CF_MOD_LOADER];
  return null;
}

/**
 * Newest version an entry may move to: a release entry only to releases, a beta to release|beta, an alpha to anything.
 * `currentType` null (new entry) prefers a release, then beta, then alpha.
 */
export function pickLatest<V extends { type: "release" | "beta" | "alpha"; publishedAt: string }>(
  versions: readonly V[],
  currentType: V["type"] | null,
): V | null {
  const newest = (allowed: readonly V["type"][]): V | null => {
    let best: V | null = null;
    for (const v of versions) {
      if (allowed.includes(v.type) && (best === null || v.publishedAt > best.publishedAt)) best = v;
    }
    return best;
  };
  if (currentType === "alpha") return newest(["release", "beta", "alpha"]);
  if (currentType === "beta") return newest(["release", "beta"]);
  if (currentType === "release") return newest(["release"]);
  return newest(["release"]) ?? newest(["beta"]) ?? newest(["alpha"]);
}

// ── DTOs (every image URL is a panel proxy path `/api/content/image?url=…` or null) ──

export interface ContentHit { platform: ContentPlatform; projectId: string; slug: string; name: string; author: string; summary: string; iconUrl: string | null; downloads: number; categories: string[] }
export interface ContentSearchDto { hits: ContentHit[]; total: number; offset: number; limit: number; stale: boolean }
export interface ContentCategoryDto { id: string; label: string }
export interface ContentProjectDto extends ContentHit { descriptionHtml: string; gallery: string[]; links: { label: string; url: string }[]; pageUrl: string; clientOnly: boolean; distributable: boolean }
export interface ContentDependencyDto { projectId: string | null; versionId: string | null; type: "required" | "optional" | "incompatible" | "embedded" }
export interface ContentVersionDto { platform: ContentPlatform; projectId: string; versionId: string; label: string; type: "release" | "beta" | "alpha"; publishedAt: string; gameVersions: string[]; loaders: string[]; dependencies: ContentDependencyDto[]; installable: boolean; reason: string | null }
/**
 * `unavailable` (only when `resolved: false`): why the panel could not tell — "source" (the platform failed, rate limited
 * or timed out) or "no_key" (CurseForge without a saved key). null = resolved, or the platform really does not know it.
 */
export type ContentUnavailable = "source" | "no_key";
export interface ContentEntryMetaDto { list: ContentListKey; raw: string; resolved: boolean; projectId: string | null; versionId: string | null; slug: string | null; name: string | null; author: string | null; iconUrl: string | null; versionLabel: string | null; versionType: "release" | "beta" | "alpha" | null; gameVersions: string[]; loaders: string[]; dependencies: ContentDependencyDto[]; unavailable: ContentUnavailable | null }
export interface ResolvedEntry { list: ContentListKey; projectId: string; versionId: string; entry: string; name: string; selected: boolean; requiredBy: string[] }
export interface ResolveResultDto { add: ResolvedEntry[]; optional: { projectId: string; name: string; requiredBy: string[] }[]; inPack: { projectId: string; name: string }[]; conflicts: string[]; unresolved: string[] }
/** `checked: false` = the source could not be asked for this entry: `latest` is then null and means "unknown", never "up to date". */
export interface UpdateDto { entry: string; projectId: string | null; currentVersionId: string | null; compatible: boolean; checked: boolean; latest: { versionId: string; label: string; type: "release" | "beta" | "alpha"; entry: string } | null }
export interface PackInfoDto { platform: ContentPlatform; projectId: string; slug: string; versionId: string; name: string; versionLabel: string; iconUrl: string | null; minecraftVersion: string | null; loader: "fabric" | "forge" | "neoforge" | "quilt" | null; loaderVersion: string | null; contents: { platform: ContentPlatform; projectId: string }[]; contentsKnown: boolean; reason: string | null }

// ── Request schemas ──

const gameVersion = z.string().regex(VERSION_QUERY_RE, "Invalid game version");
const loader = z.enum(CONTENT_LOADERS);
const contentId = z.string().regex(/^[A-Za-z0-9]{1,64}$/, "Invalid id");
const entryString = z.string().regex(ENTRY_RE, "Invalid entry: no spaces or commas (max. 300 characters)");
const listKey = z.enum(CONTENT_LIST_KEYS);

/** Query-string list: "fabric,quilt" → ["fabric","quilt"]; at most 6, each a known loader. */
const loadersParam = z
  .preprocess((v) => (typeof v === "string" ? (v === "" ? [] : v.split(",")) : v), z.array(loader).max(6))
  .default([]);

export const contentTargetSchema = z.object({ gameVersion, loaders: z.array(loader).max(6) }).strict();

export const contentSearchQuerySchema = z
  .object({
    kind: z.enum(CONTENT_KINDS),
    q: z.string().max(100).default(""),
    gameVersion: gameVersion.optional(),
    loaders: loadersParam,
    category: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "Invalid category").optional(),
    sort: z.enum(CONTENT_SORTS).default("relevance"),
    offset: z.coerce.number().int().min(0).max(9_950).default(0),
  })
  .strict();
export type ContentSearchQuery = z.infer<typeof contentSearchQuerySchema>;

export const contentVersionsQuerySchema = z
  .object({ kind: z.enum(CONTENT_KINDS), gameVersion: gameVersion.optional(), loaders: loadersParam })
  .strict();
export type ContentVersionsQuery = z.infer<typeof contentVersionsQuerySchema>;

const listEntry = z.object({ list: listKey, entry: entryString }).strict();

export const lookupRequestSchema = z.object({ entries: z.array(listEntry).max(MAX_LIST_ITEMS) }).strict();
export type LookupRequest = z.infer<typeof lookupRequestSchema>;

export const resolveRequestSchema = z
  .object({
    list: listKey,
    target: contentTargetSchema,
    selections: z.array(z.object({ projectId: contentId, versionId: contentId }).strict()).min(1).max(50),
    present: z.array(listEntry).max(MAX_LIST_ITEMS),
    pack: z.object({ platform: z.enum(CONTENT_PLATFORMS), projectId: contentId, versionId: contentId }).strict().nullable(),
  })
  .strict();
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

export const updatesRequestSchema = z
  .object({ list: listKey, target: contentTargetSchema, entries: z.array(entryString).max(MAX_LIST_ITEMS) })
  .strict();
export type UpdatesRequest = z.infer<typeof updatesRequestSchema>;
