import { BUILD_RE, type ContentVersionDto, type PackInfoDto } from "@mcsm/shared";
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
