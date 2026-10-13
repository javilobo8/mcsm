import { VERSION_LIST_TYPES, VERSION_QUERY_RE, isFloatingVersion, isStableVersion, type BuildEntry, type VersionEntry } from "@mcsm/shared";

/** Logic of the version combobox and the build selector (plan 10). Pure: tested without DOM. */

const SPECIALS = [
  { id: "LATEST", label: "LATEST — the latest stable" },
  { id: "SNAPSHOT", label: "SNAPSHOT — the latest snapshot" },
] as const;
const SNAPSHOT_TYPES = new Set(["VANILLA", "FABRIC", "QUILT"]);
/** At most this many options per group (the rest is reached by typing). */
export const MAX_OPTIONS = 200;

export const hasVersionList = (type: string): boolean => (VERSION_LIST_TYPES as readonly string[]).includes(type);

/** LATEST always; SNAPSHOT only where itzg knows how to resolve it. */
export function specialVersions(type: string): { id: string; label: string }[] {
  return SPECIALS.filter((s) => s.id === "LATEST" || SNAPSHOT_TYPES.has(type));
}

export interface VersionOptions {
  specials: { id: string; label: string }[];
  stable: string[];
  unstable: string[];
  /** Matches not shown because of the MAX_OPTIONS cap. */
  hidden: number;
  /** What was typed, for “Use “x””, or null. */
  freeText: string | null;
}

/** Combobox options: filters by what was typed; test ones only with the switch or when searching. */
export function versionOptions(type: string, list: readonly VersionEntry[], o: { query: string; showUnstable: boolean }): VersionOptions {
  const q = o.query.trim().toLowerCase();
  const match = (s: string) => q === "" || s.toLowerCase().includes(q);
  const specials = specialVersions(type).filter((s) => match(s.id) || match(s.label));
  const stableAll = list.filter((v) => v.stable && match(v.id)).map((v) => v.id);
  const unstableAll = o.showUnstable || q !== "" ? list.filter((v) => !v.stable && match(v.id)).map((v) => v.id) : [];
  const stable = stableAll.slice(0, MAX_OPTIONS);
  const unstable = unstableAll.slice(0, MAX_OPTIONS);
  return {
    specials, stable, unstable,
    hidden: stableAll.length - stable.length + unstableAll.length - unstable.length,
    freeText: freeTextOption(o.query, list),
  };
}

/** What was typed as a “Use “x”” option: a valid version that is not in the list nor LATEST/SNAPSHOT. */
export function freeTextOption(query: string, list: readonly VersionEntry[]): string | null {
  const v = query.trim();
  if (!VERSION_QUERY_RE.test(v) || isFloatingVersion(v) || list.some((e) => e.id === v)) return null;
  return v;
}

/** Open with “Show test versions” on? Yes if the current version is neither stable nor special. */
export const startsUnstable = (version: string): boolean => version !== "" && !isStableVersion(version) && !isFloatingVersion(version);

/** Why the build cannot be pinned with this version (null if it can): LATEST/SNAPSHOT or a version the API does not query. */
export function buildUnavailableReason(version: string): string | null {
  if (isFloatingVersion(version)) return "Choose a specific Minecraft version to pin the build.";
  return VERSION_QUERY_RE.test(version) ? null : "This version does not support pinning the build.";
}

const BUILD_LABELS: Record<string, string> = {
  PAPER: "Paper build", FOLIA: "Folia build", PURPUR: "Purpur build",
  FABRIC: "Fabric loader version", QUILT: "Quilt loader version",
  FORGE: "Forge version", NEOFORGE: "NeoForge version",
};
export const buildLabel = (type: string): string | null => (Object.hasOwn(BUILD_LABELS, type) ? (BUILD_LABELS[type] ?? null) : null);

/** Types whose sources publish beta builds (Paper/Folia/Purpur/Forge only list stable ones). */
export const hasUnstableBuilds = (type: string): boolean => type === "FABRIC" || type === "QUILT" || type === "NEOFORGE";

/** Build selector options: betas only with the switch; the current one always, even if it is no longer in the list. */
export function buildOptions(list: readonly BuildEntry[], current: string, showUnstable: boolean): { value: string; label: string }[] {
  const out = list
    .filter((b) => b.stable || showUnstable || b.id === current)
    .map((b) => ({ value: b.id, label: `${b.id}${b.recommended ? " (recommended)" : ""}${b.stable ? "" : " (beta)"}` }));
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

/** “15 min ago”, “2 h ago”, “3 days ago” for the stale-list notice. */
export function ageText(fetchedAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** On leaving the hand-typed version field: nothing if not edited, trim if only spaces changed, apply if it really changed. */
export function blurVersionAction(atFocus: string, raw: string): "none" | "trim" | "apply" {
  if (raw === atFocus) return "none";
  return raw.trim() === atFocus.trim() ? "trim" : "apply";
}

/** Do version, Java or build differ? (`build` absent in old specs = empty). */
export function specChanged(
  a: { version: string; imageTag: string; build?: string | undefined },
  b: { version: string; imageTag: string; build?: string | undefined },
): boolean {
  return a.version !== b.version || a.imageTag !== b.imageTag || (a.build ?? "") !== (b.build ?? "");
}
