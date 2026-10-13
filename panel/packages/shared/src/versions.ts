import type { z } from "zod";

/**
 * Selector de versiones (plan 10, spec docs/superpowers/specs/2026-10-13-selector-versiones-design.md):
 * tipos con lista de versiones, campo `build` de la spec y su variable de itzg, comparación de
 * versiones y Java mínima. Las reglas de `build` son espejo de agent/internal/spec/build.go; los casos
 * de proto/fixtures/build-cases.json se prueban en los dos lados.
 */

/** Tipos con lista de versiones de Minecraft (los modpacks y los desconocidos van con texto libre). */
export const VERSION_LIST_TYPES = ["VANILLA", "PAPER", "FOLIA", "PURPUR", "SPIGOT", "FABRIC", "QUILT", "FORGE", "NEOFORGE"] as const;
export type VersionListType = (typeof VERSION_LIST_TYPES)[number];

/** Variable de itzg que genera `build` según el tipo; solo estos tipos admiten build. Folia: FOLIABUILD (scripts/start-deployFolia). */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  PAPER: "PAPER_BUILD", FOLIA: "FOLIABUILD", PURPUR: "PURPUR_BUILD",
  FABRIC: "FABRIC_LOADER_VERSION", QUILT: "QUILT_LOADER_VERSION",
  FORGE: "FORGE_VERSION", NEOFORGE: "NEOFORGE_VERSION",
};
export const buildEnvFor = (type: string): string | undefined => (Object.hasOwn(BUILD_ENV, type) ? BUILD_ENV[type] : undefined);

/** Build/loader: ASCII sin espacios ni barras, máx. 64. La versión que se pide a la API usa la misma gramática. */
export const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const VERSION_QUERY_RE = BUILD_RE;

/** LATEST / SNAPSHOT (sin distinguir mayúsculas): itzg elige la versión al arrancar. */
export const isFloatingVersion = (v: string): boolean => /^(latest|snapshot)$/iu.test(v);

/** Estable = solo dígitos y puntos (1.21.11, 26.3). Pre-releases, rc y snapshots no lo son. */
export const isStableVersion = (v: string): boolean => /^\d+(\.\d+)*$/.test(v);

export const BUILD_MESSAGES = {
  invalid: "Build inválido: letras, números y . _ + - (máx. 64; empieza por letra o número)",
  type: (type: string) => `El tipo ${type} no admite fijar el build (solo Paper, Folia, Purpur, Fabric, Quilt, Forge y NeoForge)`,
  floating: "Para fijar el build elige una versión concreta de Minecraft (no LATEST ni SNAPSHOT)",
  env: (key: string) => `Quita la variable ${key} de las variables de entorno (Avanzado): la fija el campo Build`,
};

/** Primer motivo por el que `build` no vale en esta spec (con la ruta del campo); null si vale o está vacío. */
export function buildError(s: { type: string; version: string; build: string; env: Record<string, string> }): { path: string[]; message: string } | null {
  if (s.build === "") return null;
  if (!BUILD_RE.test(s.build)) return { path: ["build"], message: BUILD_MESSAGES.invalid };
  const key = buildEnvFor(s.type);
  if (!key) return { path: ["build"], message: BUILD_MESSAGES.type(s.type) };
  if (isFloatingVersion(s.version)) return { path: ["build"], message: BUILD_MESSAGES.floating };
  // El env libre gana sobre lo generado: con build fijado, su variable en env lo anularía en silencio.
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

/** Compara versiones: > 0 si `a` es más nueva (1.21.10 > 1.21.9; 26.1 > 1.21.11; una release > su pre-release). */
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
 * Etiqueta de imagen itzg con la Java mínima que pide la versión de Minecraft; null si no se reconoce.
 * 26.x → 25; 1.20.5–1.21.x → 21; 1.17–1.20.4 → 17; anteriores → 8. Snapshots antiguas AAwSSl:
 * ≥ 24w14a → 21, ≥ 21w19a → 17. LATEST/SNAPSHOT → 25 (la última).
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

/** Número de Java de una etiqueta itzg ("java21-graalvm" → 21); null si no empieza por javaNN. */
export function javaMajor(tag: string): number | null {
  const m = /^java(\d+)/.exec(tag);
  return m ? Number(m[1]) : null;
}

export interface VersionEntry { id: string; stable: boolean }
export interface BuildEntry { id: string; stable: boolean; recommended: boolean }
export interface VersionListDto { type: string; versions: VersionEntry[]; fetchedAt: string; stale: boolean }
export interface BuildListDto { type: string; version: string; builds: BuildEntry[]; fetchedAt: string; stale: boolean }
