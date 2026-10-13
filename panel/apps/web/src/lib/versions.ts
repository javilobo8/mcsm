import { VERSION_LIST_TYPES, VERSION_QUERY_RE, isFloatingVersion, isStableVersion, type BuildEntry, type VersionEntry } from "@mcsm/shared";

/** Lógica del combobox de versión y del selector de build (plan 10). Puras: se prueban sin DOM. */

const SPECIALS = [
  { id: "LATEST", label: "LATEST — la última estable" },
  { id: "SNAPSHOT", label: "SNAPSHOT — la última snapshot" },
] as const;
const SNAPSHOT_TYPES = new Set(["VANILLA", "FABRIC", "QUILT"]);
/** Opciones como mucho por grupo (el resto se alcanza escribiendo). */
export const MAX_OPTIONS = 200;

export const hasVersionList = (type: string): boolean => (VERSION_LIST_TYPES as readonly string[]).includes(type);

/** LATEST siempre; SNAPSHOT solo donde itzg sabe resolverla. */
export function specialVersions(type: string): { id: string; label: string }[] {
  return SPECIALS.filter((s) => s.id === "LATEST" || SNAPSHOT_TYPES.has(type));
}

export interface VersionOptions {
  specials: { id: string; label: string }[];
  stable: string[];
  unstable: string[];
  /** Coincidencias que no se muestran por el tope de MAX_OPTIONS. */
  hidden: number;
  /** Lo escrito, para «Usar «x»», o null. */
  freeText: string | null;
}

/** Opciones del combobox: filtra por lo escrito; las de prueba solo con el interruptor o al buscar. */
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

/** Lo escrito como opción «Usar «x»»: una versión válida que no está en la lista ni es LATEST/SNAPSHOT. */
export function freeTextOption(query: string, list: readonly VersionEntry[]): string | null {
  const v = query.trim();
  if (!VERSION_QUERY_RE.test(v) || isFloatingVersion(v) || list.some((e) => e.id === v)) return null;
  return v;
}

/** ¿Abrir con «Mostrar versiones de prueba» encendido? Sí si la versión actual no es estable ni especial. */
export const startsUnstable = (version: string): boolean => version !== "" && !isStableVersion(version) && !isFloatingVersion(version);

const BUILD_LABELS: Record<string, string> = {
  PAPER: "Build de Paper", FOLIA: "Build de Folia", PURPUR: "Build de Purpur",
  FABRIC: "Versión del loader de Fabric", QUILT: "Versión del loader de Quilt",
  FORGE: "Versión de Forge", NEOFORGE: "Versión de NeoForge",
};
export const buildLabel = (type: string): string | null => (Object.hasOwn(BUILD_LABELS, type) ? (BUILD_LABELS[type] ?? null) : null);

/** Tipos cuyas fuentes publican builds beta (Paper/Folia/Purpur/Forge solo listan estables). */
export const hasUnstableBuilds = (type: string): boolean => type === "FABRIC" || type === "QUILT" || type === "NEOFORGE";

/** Opciones del selector de build: betas solo con el interruptor; la actual siempre, aunque ya no esté en la lista. */
export function buildOptions(list: readonly BuildEntry[], current: string, showUnstable: boolean): { value: string; label: string }[] {
  const out = list
    .filter((b) => b.stable || showUnstable || b.id === current)
    .map((b) => ({ value: b.id, label: `${b.id}${b.recommended ? " (recomendada)" : ""}${b.stable ? "" : " (beta)"}` }));
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}

/** «hace 15 min», «hace 2 h», «hace 3 días» para el aviso de lista desactualizada. */
export function ageText(fetchedAt: string, now: number): string {
  const min = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

/** Al salir del campo de versión escrita a mano: nada si no se editó, recortar si solo cambiaron espacios, aplicar si cambió de verdad. */
export function blurVersionAction(atFocus: string, raw: string): "none" | "trim" | "apply" {
  if (raw === atFocus) return "none";
  return raw.trim() === atFocus.trim() ? "trim" : "apply";
}

/** ¿Difieren versión, Java o build? (`build` ausente en specs antiguas = vacío). */
export function specChanged(
  a: { version: string; imageTag: string; build?: string | undefined },
  b: { version: string; imageTag: string; build?: string | undefined },
): boolean {
  return a.version !== b.version || a.imageTag !== b.imageTag || (a.build ?? "") !== (b.build ?? "");
}
