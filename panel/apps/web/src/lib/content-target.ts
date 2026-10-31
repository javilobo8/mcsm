import {
  VERSION_QUERY_RE, isFloatingVersion, modrinthLoadersFor,
  type ContentKind, type ContentPlatform, type ContentTarget, type PackInfoDto,
} from "@mcsm/shared";
import type { EditableSpec } from "./spec-edit";

/** One tab of the content browser: a source and a kind of content. */
export type BrowserTab = { platform: ContentPlatform; kind: ContentKind };

export const FLOATING_REASON = "Browsing needs a concrete Minecraft version: LATEST and SNAPSHOT change by themselves, and pinned content would stop matching.";
export const PACK_WAITING_REASON = "Waiting for the modpack's details (loader and Minecraft version)";
export const PACK_UNKNOWN_REASON = "The modpack does not say which loader and Minecraft version it runs: the browser cannot tell what fits";
export const NO_VERSION_REASON = "Choose a Minecraft version to browse compatible content.";

/** The CurseForge Plugins tab exists: the itzg spike (F1) confirmed CURSEFORGE_FILES installs Bukkit plugins. */
export const CURSEFORGE_PLUGINS = true;

const PLUGIN_TYPES = new Set(["PAPER", "PURPUR", "FOLIA", "SPIGOT"]);
const MOD_TYPES = new Set(["FABRIC", "FORGE", "NEOFORGE", "QUILT", "MODRINTH", "AUTO_CURSEFORGE"]);
const PACK_TYPES = new Set(["MODRINTH", "AUTO_CURSEFORGE"]);

const tab = (platform: ContentPlatform, kind: ContentKind): BrowserTab => ({ platform, kind });

/** Tabs the browser offers for a server type, Modrinth first. */
export function browserTabs(type: string, o: { curseforgePlugins: boolean }): BrowserTab[] {
  if (type === "VANILLA") return [tab("modrinth", "datapack"), tab("modrinth", "modpack"), tab("curseforge", "modpack")];
  if (PLUGIN_TYPES.has(type)) return [tab("modrinth", "plugin"), tab("modrinth", "datapack"), ...(o.curseforgePlugins ? [tab("curseforge", "plugin")] : [])];
  if (MOD_TYPES.has(type)) return [tab("modrinth", "mod"), tab("modrinth", "datapack"), tab("modrinth", "modpack"), tab("curseforge", "mod"), tab("curseforge", "modpack")];
  return [tab("modrinth", "datapack")];
}

export const isPackType = (type: string): boolean => PACK_TYPES.has(type);
const concrete = (v: string) => !isFloatingVersion(v) && VERSION_QUERY_RE.test(v);

/** `waiting`: the reason goes away on its own (the pack's details are loading). */
export type BrowseTarget = { ok: true; target: ContentTarget } | { ok: false; reason: string; pinTo?: "release"; waiting?: true };

/**
 * What a search must match for `kind` content on this server: Minecraft version and loaders. Modpacks never need
 * a concrete version (they bring their own); everything else does. Modpack servers take both from the pack;
 * `packError` says why its details will not come (see `packDetailsError`).
 */
export function browseTarget(spec: EditableSpec, kind: ContentKind, pack: PackInfoDto | null, packError: string | null = null): BrowseTarget {
  if (kind === "modpack") return { ok: true, target: { gameVersion: concrete(spec.version) ? spec.version : "", loaders: [] } };
  if (isPackType(spec.type)) {
    if (!pack) return packError ? { ok: false, reason: packError } : { ok: false, reason: PACK_WAITING_REASON, waiting: true };
    if (!pack.minecraftVersion || (kind === "mod" && !pack.loader)) return { ok: false, reason: PACK_UNKNOWN_REASON };
    return { ok: true, target: { gameVersion: pack.minecraftVersion, loaders: modrinthLoadersFor(spec.type, kind, pack.loader) } };
  }
  if (isFloatingVersion(spec.version)) return { ok: false, reason: FLOATING_REASON, pinTo: "release" };
  if (!VERSION_QUERY_RE.test(spec.version)) return { ok: false, reason: NO_VERSION_REASON };
  return { ok: true, target: { gameVersion: spec.version, loaders: modrinthLoadersFor(spec.type, kind) } };
}
