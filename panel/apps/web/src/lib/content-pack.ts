import { BUILD_RE, CF_ID_RE, MODRINTH_ID_RE, pickLatest, type ContentPlatform, type ContentVersionDto, type PackInfoDto } from "@mcsm/shared";
import { ApiError } from "./api";
import { withType, withVersion, type EditableSpec } from "./spec-edit";

/** Modpack lifecycle in the form (install, change version, switch, uninstall). Pure: the Save confirmation applies it. */

export type PackChange = "none" | "install" | "upgrade" | "downgrade" | "switch" | "uninstall" | "unknown";
type Modpack = EditableSpec["modpack"];

/** What the edit does to the pack. `versions` is the pack's version list, newest first. */
export function packChange(base: Modpack, edited: Modpack, versions: readonly ContentVersionDto[] | undefined): PackChange {
  if (!base && !edited) return "none";
  if (!base) return "install";
  if (!edited) return "uninstall";
  if (base.platform !== edited.platform || base.slugOrUrl !== edited.slugOrUrl) return "switch";
  if (base.versionId === edited.versionId) return "none";
  const from = versions?.findIndex((v) => v.versionId === base.versionId) ?? -1;
  const to = versions?.findIndex((v) => v.versionId === edited.versionId) ?? -1;
  if (from < 0 || to < 0) return "unknown";
  return to < from ? "upgrade" : "downgrade";
}

/** Modrinth packs are stored by project id (stable across renames); CurseForge's CF_SLUG needs the slug. */
export const packSlugOrUrl = (info: PackInfoDto): string => (info.platform === "modrinth" ? info.projectId : info.slug);

/** Clears `build` only when the spec has one: old specs without the key get no phantom change. */
const clearBuild = (s: EditableSpec): EditableSpec => (s.build ? { ...s, build: "" } : s);

/** Installs (or switches to) a pack: its type, the pinned pack section and the Minecraft version it brings. */
export function withPackInstalled(spec: EditableSpec, info: PackInfoDto): EditableSpec {
  const type = info.platform === "modrinth" ? "MODRINTH" : "AUTO_CURSEFORGE";
  let next: EditableSpec = {
    ...withType(spec, type),
    modpack: { platform: type, slugOrUrl: packSlugOrUrl(info), versionId: info.versionId, loader: info.platform === "modrinth" ? (info.loader ?? "") : "" },
  };
  if (info.minecraftVersion) next = withVersion(next, info.minecraftVersion).spec;
  return clearBuild(next);
}

export const UNKNOWN_LOADER = "The modpack's loader is unknown: choose the server type by hand";

/** Uninstalls the pack keeping the world loadable: the server becomes its loader, with the pack's versions. */
export function withPackUninstalled(spec: EditableSpec, info: PackInfoDto | null): { ok: true; spec: EditableSpec } | { ok: false; error: string } {
  if (!info?.loader || !info.minecraftVersion) return { ok: false, error: UNKNOWN_LOADER };
  const next = withVersion(withType(spec, info.loader.toUpperCase()), info.minecraftVersion).spec;
  const build = info.loaderVersion && BUILD_RE.test(info.loaderVersion) ? info.loaderVersion : "";
  return { ok: true, spec: build || next.build !== undefined ? { ...next, build } : next };
}

export interface PackRef { platform: ContentPlatform; projectId: string | null; slug: string | null; versionId: string }

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Last path segment after `/modpack(s)/` in a project page URL ("…/modpacks/all-the-mods-10/files/1" → slug). */
function slugFromUrl(v: string): string | null {
  const m = /^https?:\/\/[^/]+\/(?:minecraft\/)?modpacks?\/([^/?#]+)/.exec(v);
  return m && SLUG_RE.test(m[1]!) ? m[1]! : null;
}

/**
 * How to ask the panel about the spec's pack. Modrinth takes an id or a slug as the project; CurseForge only a numeric
 * id, so a CurseForge slug is found by searching. FTB, an empty pack or something unrecognisable → null (manual card).
 */
export function packRefOf(mp: Modpack): PackRef | null {
  if (!mp || mp.platform === "FTBA" || mp.slugOrUrl === "") return null;
  const v = mp.slugOrUrl;
  const slug = SLUG_RE.test(v) ? v : slugFromUrl(v);
  if (mp.platform === "MODRINTH") return slug ? { platform: "modrinth", projectId: slug, slug: null, versionId: mp.versionId } : null;
  if (CF_ID_RE.test(v)) return { platform: "curseforge", projectId: v, slug: null, versionId: mp.versionId };
  return slug ? { platform: "curseforge", projectId: null, slug, versionId: mp.versionId } : null;
}

/**
 * The pack to ask the panel about: the project (a Modrinth slug as typed, the panel resolves it; a CurseForge slug
 * through the id `found` by search) and the pinned version among `versions` (newest first): by id, by a hand-typed
 * label, the newest release when empty. An id the list does not hold is kept (the list has only the newest
 * versions); otherwise null while unknown.
 */
export function installedPackIds(ref: PackRef, found: string | null, versions: readonly ContentVersionDto[] | undefined): { projectId: string | null; versionId: string | null } {
  const projectId = ref.projectId ?? found;
  const match = versions?.find((v) => v.versionId === ref.versionId || v.label === ref.versionId);
  if (match) return { projectId, versionId: match.versionId };
  if (ref.versionId === "") return { projectId, versionId: versions ? (pickLatest(versions, null)?.versionId ?? null) : null };
  return { projectId, versionId: ref.platform === "curseforge" || MODRINTH_ID_RE.test(ref.versionId) ? ref.versionId : null };
}

export interface PackDetailsState {
  modpack: Modpack;
  ref: PackRef | null;
  slugNotFound: boolean;
  /** The first failure among the slug search, the version list and the pack details. */
  error: unknown;
  versionsLoaded: boolean;
  versionId: string | null;
}

/** Why the pack's details will not come (instead of waiting for them forever); null while they may still come, or did. */
export function packDetailsError(s: PackDetailsState): string | null {
  if (!s.modpack || s.modpack.platform === "FTBA") return null;
  if (s.modpack.slugOrUrl === "") return "No modpack chosen yet";
  if (!s.ref) return "The modpack is written in a way the browser cannot look up: use Edit as text";
  if (s.slugNotFound) return `“${s.ref.slug}” was not found on CurseForge: check it with Edit as text`;
  if (s.error) {
    if (s.error instanceof ApiError && s.error.status === 404) return s.error.message;
    return `Could not load the modpack's details: ${s.error instanceof Error ? s.error.message : "Unexpected error"}`;
  }
  if (s.versionsLoaded && s.versionId === null) {
    return s.ref.versionId === "" ? "The modpack has no release to install" : `Version “${s.ref.versionId}” of the modpack was not found`;
  }
  return null;
}
