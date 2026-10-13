import { z } from "zod";
import { compareVersions, isStableVersion, type BuildEntry, type VersionEntry, type VersionListType } from "@mcsm/shared";

/**
 * Fuentes oficiales de versiones (spec 2026-10-13-selector-versiones-design.md §2). Cada adaptador pide
 * sus documentos con `get` (el VersionCatalog pone caché, plazo y topes) y los normaliza a listas de
 * más nueva a más antigua. Una respuesta con forma inesperada lanza UpstreamError (→ 502 o lista
 * guardada), nunca un 500.
 */

export class UpstreamError extends Error {
  /** `status`: HTTP de la fuente, o null (red, plazo, tamaño, forma inesperada). */
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface GetOptions { kind?: "json" | "text"; ttl?: "list" | "builds" }
/**
 * `get` valida el documento con `schema` ANTES de guardarlo en la caché: una respuesta con otra forma es
 * un fallo de la fuente (se sirve lo guardado con `stale`). Cada URL tiene exactamente un esquema, porque
 * la caché guarda el documento ya validado.
 */
export type Get = <T>(url: string, schema: z.ZodType<T>, opts?: GetOptions) => Promise<T>;

export interface Source {
  /** Nombre para los mensajes ("No se pudo consultar la lista de versiones de Paper"). */
  label: string;
  versions(get: Get): Promise<VersionEntry[]>;
  builds?(get: Get, version: string): Promise<BuildEntry[]>;
}

const MOJANG = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FILL = "https://fill.papermc.io/v3/projects";
const PURPUR = "https://api.purpurmc.org/v2/purpur";
const SPIGOT = "https://hub.spigotmc.org/versions/";
const FABRIC = "https://meta.fabricmc.net/v2/versions";
const QUILT = "https://meta.quiltmc.org/v3/versions";
const FORGE_META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const FORGE_PROMOS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const NEOFORGE = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

const HOSTS = new Set([MOJANG, FILL, PURPUR, SPIGOT, FABRIC, QUILT, FORGE_META, NEOFORGE].map((u) => new URL(u).host));

/** Solo HTTPS y solo los hosts de las fuentes (el catálogo lo comprueba antes de cada descarga). */
export function allowedSource(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOSTS.has(u.host);
  } catch {
    return false;
  }
}

const newestFirst = <T extends { id: string }>(xs: T[]): T[] => [...xs].sort((a, b) => compareVersions(b.id, a.id));
const unique = (xs: string[]): string[] => [...new Set(xs)];
const enc = encodeURIComponent;
const asVersions = (ids: string[]): VersionEntry[] => newestFirst(unique(ids).map((id) => ({ id, stable: isStableVersion(id) })));
const build = (id: string, stable = true, recommended = false): BuildEntry => ({ id, stable, recommended });

const metaGame = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const versionsDoc = z.object({ versions: z.array(z.string()) });

// Mojang, Fabric y Quilt ya vienen de más nueva a más antigua y mezclan snapshots con nombres que
// compareVersions no ordena (25w14a): se respeta su orden.
const vanilla: Source = {
  label: "Minecraft",
  async versions(get) {
    const doc = await get(MOJANG, z.object({ versions: z.array(z.object({ id: z.string(), type: z.string() })) }));
    return doc.versions.filter((v) => v.type === "release" || v.type === "snapshot").map((v) => ({ id: v.id, stable: v.type === "release" }));
  },
};

function fill(project: "paper" | "folia", label: string): Source {
  return {
    label,
    async versions(get) {
      const doc = await get(`${FILL}/${project}`, z.object({ versions: z.record(z.string(), z.array(z.string())) }));
      return asVersions(Object.values(doc.versions).flat());
    },
    async builds(get, version) {
      const doc = await get(`${FILL}/${project}/versions/${enc(version)}/builds`, z.array(z.object({ id: z.number().int(), channel: z.string() })), { ttl: "builds" });
      // Solo STABLE: un build experimental exigiría PAPER_CHANNEL/FOLIA_CHANNEL=experimental.
      return doc.filter((b) => b.channel === "STABLE").sort((a, b) => b.id - a.id).map((b) => build(String(b.id)));
    },
  };
}

const purpur: Source = {
  label: "Purpur",
  async versions(get) {
    return asVersions((await get(PURPUR, versionsDoc)).versions);
  },
  async builds(get, version) {
    const doc = await get(`${PURPUR}/${enc(version)}`, z.object({ builds: z.object({ all: z.array(z.string()) }) }), { ttl: "builds" });
    return newestFirst(unique(doc.builds.all).map((id) => build(id)));
  },
};

const spigot: Source = {
  label: "Spigot",
  async versions(get) {
    const html = await get(SPIGOT, z.string(), { kind: "text" });
    // Índice de BuildTools: <versión>.json; los números sueltos (3000.json) son builds internos.
    return asVersions([...html.matchAll(/href="(\d+\.\d+(?:\.\d+)?)\.json"/g)].map((m) => m[1]!));
  },
};

const fabric: Source = {
  label: "Fabric",
  async versions(get) {
    return (await get(`${FABRIC}/game`, metaGame)).map((g) => ({ id: g.version, stable: g.stable }));
  },
  async builds(get, version) {
    const doc = await get(`${FABRIC}/loader/${enc(version)}`, z.array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) })), { ttl: "builds" });
    return doc.map((l) => build(l.loader.version, l.loader.stable));
  },
};

const quilt: Source = {
  label: "Quilt",
  async versions(get) {
    return (await get(`${QUILT}/game`, metaGame)).map((g) => ({ id: g.version, stable: g.stable }));
  },
  async builds(get, version) {
    const doc = await get(`${QUILT}/loader/${enc(version)}`, z.array(z.object({ loader: z.object({ version: z.string() }) })), { ttl: "builds" });
    return newestFirst(unique(doc.map((l) => l.loader.version)).map((id) => build(id, isStableVersion(id))));
  },
};

/** "1.20.1-47.4.27" → "47.4.27"; las antiguas ("1.7.10-10.13.4.1614-1.7.10") repiten la versión al final. */
export function forgeBuildId(full: string, mc: string): string {
  let id = full.startsWith(`${mc}-`) ? full.slice(mc.length + 1) : full;
  if (id.endsWith(`-${mc}`)) id = id.slice(0, -(mc.length + 1));
  return id;
}

const forgeMeta = z.record(z.string(), z.array(z.string()));
const forge: Source = {
  label: "Forge",
  async versions(get) {
    return asVersions(Object.keys(await get(FORGE_META, forgeMeta)));
  },
  async builds(get, version) {
    const meta = await get(FORGE_META, forgeMeta);
    const promos = (await get(FORGE_PROMOS, z.object({ promos: z.record(z.string(), z.string()) }), { ttl: "builds" })).promos;
    const recommended = promos[`${version}-recommended`];
    const ids = Object.hasOwn(meta, version) ? (meta[version] ?? []) : [];
    return newestFirst(unique(ids.map((full) => forgeBuildId(full, version))).map((id) => build(id, true, id === recommended)));
  },
};

/**
 * Versión de Minecraft de una de NeoForge (parte antes del primer "-"): mayor ≥ 26 → 26.3.0.76 = 26.3,
 * 26.1.2.5 = 26.1.2; mayor 20–25 → 21.0.167 = 1.21, 21.1.77 = 1.21.1. Otras formas → null.
 */
export function neoforgeMcVersion(v: string): string | null {
  const p = (v.split("-")[0] ?? "").split(".");
  if (!p.every((x) => /^\d+$/.test(x))) return null;
  const major = Number(p[0]);
  if (major >= 26 && p.length === 4) return p[2] === "0" ? `${p[0]}.${p[1]}` : `${p[0]}.${p[1]}.${p[2]}`;
  if (major >= 20 && major <= 25 && p.length === 3) return p[1] === "0" ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
  return null;
}

const neoforge: Source = {
  label: "NeoForge",
  async versions(get) {
    const all = (await get(NEOFORGE, versionsDoc)).versions;
    return asVersions(all.map(neoforgeMcVersion).filter((v): v is string => v !== null));
  },
  async builds(get, version) {
    const all = (await get(NEOFORGE, versionsDoc)).versions;
    return newestFirst(all.filter((v) => neoforgeMcVersion(v) === version).map((id) => build(id, !id.includes("-"))));
  },
};

export const SOURCES: Readonly<Record<VersionListType, Source>> = {
  VANILLA: vanilla, PAPER: fill("paper", "Paper"), FOLIA: fill("folia", "Folia"), PURPUR: purpur, SPIGOT: spigot,
  FABRIC: fabric, QUILT: quilt, FORGE: forge, NEOFORGE: neoforge,
};
