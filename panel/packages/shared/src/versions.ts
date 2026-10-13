import type { z } from "zod";

/**
 * Version selector (plan 10, spec docs/superpowers/specs/2026-10-13-version-selector-design.md):
 * types with a version list, the spec's `build` field and its itzg variable, version
 * comparison and minimum Java. The `build` rules mirror agent/internal/spec/build.go; the cases
 * in proto/fixtures/build-cases.json are tested on both sides.
 */

/** Types with a Minecraft version list (modpacks and unknown ones use free text). */
export const VERSION_LIST_TYPES = ["VANILLA", "PAPER", "FOLIA", "PURPUR", "SPIGOT", "FABRIC", "QUILT", "FORGE", "NEOFORGE"] as const;
export type VersionListType = (typeof VERSION_LIST_TYPES)[number];

/** itzg variable that `build` generates by type; only these types allow a build. Folia: FOLIABUILD (scripts/start-deployFolia). */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD",
  FABRIC: "FABRIC_LOADER_VERSION", QUILT: "QUILT_LOADER_VERSION",
  FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
};
export const buildEnvFor = (type: string): string | undefined => (Object.hasOwn(BUILD_ENV, type) ? BUILD_ENV[type] : undefined);

/** Build/loader: ASCII without spaces or slashes, max. 64. The version requested from the API uses the same grammar. */
export const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const VERSION_QUERY_RE = BUILD_RE;

/** LATEST / SNAPSHOT (case-insensitive): itzg chooses the version on startup. */
export const isFloatingVersion = (v: string): boolean => /^(latest|snapshot)$/iu.test(v);

/** Stable = only digits and dots (1.21.11, 26.3). Pre-releases, rc and snapshots are not. */
export const isStableVersion = (v: string): boolean => /^\d+(\.\d+)*$/.test(v);

export const BUILD_MESSAGES = {
  invalid: "Invalid build: letters, numbers and . _ + - (max. 64; starts with a letter or number)",
  type: (type: string) => `The ${type} type does not support pinning the build (only Paper, Folia, Purpur, Fabric, Quilt, Forge and NeoForge)`,
  floating: "To pin the build choose a specific Minecraft version (not LATEST or SNAPSHOT)",
  env: (key: string) => `Remove the ${key} variable from the environment variables (Advanced): it is set by the Build field`,
};

/** First reason `build` is not valid in this spec (with the field path); null if valid or empty. */
export function buildError(s: { type: string; version: string; build: string; env: Record<string, string> }): { path: string[]; message: string } | null {
  if (s.build === "") return null;
  if (!BUILD_RE.test(s.build)) return { path: ["build"], message: BUILD_MESSAGES.invalid };
  const key = buildEnvFor(s.type);
  if (!key) return { path: ["build"], message: BUILD_MESSAGES.type(s.type) };
  if (isFloatingVersion(s.version)) return { path: ["build"], message: BUILD_MESSAGES.floating };
  // The free env wins over what is generated: with build set, its variable in env would silently override it.
  if (Object.hasOwn(s.env, key)) return { path: ["env", key], message: BUILD_MESSAGES.env(key) };
  return null;
}

export function buildCheck(s: Parameters<typeof buildError>[0], ctx: z.RefinementCtx) {
  const e = buildError(s);
  if (e) ctx.addIssue({ code: "custom", path: e.path, message: e.message });
}

function splitPre(v: string): [string, string] {
  const i = v.search(/[-_+]/);
  return i < 0 ? [v, ""] : [v.slice(0, i), v.slice(i + 1)];
}

function compareTokens(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "0";
    const y = b[i] ?? "0";
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    const c = nx && ny ? Number(x) - Number(y) : nx ? 1 : ny ? -1 : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Compares versions: > 0 if `a` is newer (1.21.10 > 1.21.9; 26.1 > 1.21.11; a release > its pre-release). */
export function compareVersions(a: string, b: string): number {
  const [aBase, aPre] = splitPre(a);
  const [bBase, bPre] = splitPre(b);
  const c = compareTokens(aBase.split("."), bBase.split("."));
  if (c !== 0) return c;
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return compareTokens(aPre.split(/[.\-_+]/), bPre.split(/[.\-_+]/));
}

/**
 * itzg image tag with the minimum Java the Minecraft version asks for; null if not recognized.
 * 26.x → 25; 1.20.5–1.21.x → 21; 1.17–1.20.4 → 17; earlier → 8. Old AAwSSl snapshots:
 * ≥ 24w14a → 21, ≥ 21w19a → 17. LATEST/SNAPSHOT → 25 (the latest).
 */
export function minJavaTag(version: string): "java8" | "java17" | "java21" | "java25" | null {
  const v = version.trim();
  if (isFloatingVersion(v)) return "java25";
  const old = /^(\d{2})w(\d{2})[a-z]$/.exec(v);
  if (old) {
    const n = Number(old[1]) * 100 + Number(old[2]);
    return n >= 2414 ? "java21" : n >= 2119 ? "java17" : "java8";
  }
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-_+].*)?$/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major >= 26) return "java25";
  if (major !== 1) return null;
  if (minor < 17) return "java8";
  if (minor < 20 || (minor === 20 && patch <= 4)) return "java17";
  return "java21";
}

/** Java number of an itzg tag ("java21-graalvm" → 21); null if it does not start with javaNN. */
export function javaMajor(tag: string): number | null {
  const m = /^java(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
}

export interface VersionEntry { id: string; stable: boolean }
export interface BuildEntry { id: string; stable: boolean; recommended: boolean }
export interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }
export interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }
