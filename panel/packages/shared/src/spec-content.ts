import { z } from "zod";

/**
 * Secciones de contenido de la spec (§4.1): modpack, mods, plugins, whitelist y ops.
 * Espejo exacto de agent/internal/spec/content.go; los casos de
 * proto/fixtures/spec-content-cases.json se prueban en los dos lados.
 * Ausente no es vacío: `ops` y `whitelist` son opcionales sin default, y un `[]`
 * explícito se conserva (sincroniza el fichero en el agente).
 */

export const MODPACK_PLATFORMS = ["MODRINTH", "AUTO_CURSEFORGE", "FTBA"] as const;
export type ModpackPlatform = (typeof MODPACK_PLATFORMS)[number];
export const MODRINTH_LOADERS = ["", "fabric", "forge", "quilt", "neoforge"] as const;

// ASCII imprimible sin espacios ni comas. No usar \s: en JS incluye espacios Unicode y en Go no.
export const ENTRY_RE = /^[!-+\--~]{1,300}$/;
export const URL_RE = /^https?:\/\/[!-+\--~]{1,1000}$/;
export const DIGITS_RE = /^[0-9]{1,12}$/;
export const PLAYER_RE = /^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$/;
/** API key de CurseForge ($2a$10$… de bcrypt): ASCII imprimible sin espacios, 1-200. Misma regex que cfAPIKeyRe (Go). */
export const CURSEFORGE_API_KEY_RE = /^[\x21-\x7E]{1,200}$/;

const entry = z.string().regex(ENTRY_RE, "Entrada inválida: sin espacios ni comas (máx. 300 caracteres)");
const url = z.string().regex(URL_RE, "URL inválida: debe empezar por http:// o https:// y no tener espacios ni comas");
const spigetId = z.string().regex(DIGITS_RE, "Los recursos de Spiget son ids numéricos");
const player = z.string().regex(PLAYER_RE, "Jugador inválido: nombre de Java (1-16 letras, números o _) o UUID");

export const modpackSchema = z
  .object({
    platform: z.enum(MODPACK_PLATFORMS, "Plataforma de modpack inválida (MODRINTH, AUTO_CURSEFORGE o FTBA)"),
    slugOrUrl: z.string().regex(ENTRY_RE, "Indica el modpack (slug, id o URL) sin espacios ni comas"),
    versionId: z.union([z.literal(""), entry]).default(""),
    loader: z.enum(MODRINTH_LOADERS, "Loader inválido (fabric, forge, quilt o neoforge)").default(""),
  })
  .superRefine((mp, ctx) => {
    if (mp.platform !== "MODRINTH" && mp.loader !== "") {
      ctx.addIssue({ code: "custom", path: ["loader"], message: "El loader solo se elige en modpacks de Modrinth" });
    }
    if (mp.platform === "AUTO_CURSEFORGE" && mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)) {
      ctx.addIssue({ code: "custom", path: ["versionId"], message: "En CurseForge la versión es el id numérico del fichero" });
    }
    if (mp.platform === "FTBA" && (!DIGITS_RE.test(mp.slugOrUrl) || (mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)))) {
      ctx.addIssue({ code: "custom", path: ["slugOrUrl"], message: "Los modpacks de FTB se indican con su id numérico (y versión numérica)" });
    }
  });

export const modsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  curseforgeFiles: z.array(entry).default([]),
  urls: z.array(url).default([]),
});

export const pluginsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  spigetResources: z.array(spigetId).default([]),
  urls: z.array(url).default([]),
});

export const whitelistSchema = z.object({
  enabled: z.boolean().default(false),
  players: z.array(player).default([]),
});

/** Campos que se añaden a la spec (todos opcionales: sin ellos la spec es la del Plan 1). */
export const contentFields = {
  modpack: modpackSchema.optional(),
  mods: modsSchema.optional(),
  plugins: pluginsSchema.optional(),
  whitelist: whitelistSchema.optional(),
  ops: z.array(player).optional(),
};

const WHITELIST_PROPS = ["white-list", "enforce-whitelist"];

type ContentShape = {
  type: string;
  properties: Record<string, string>;
  modpack?: { platform: ModpackPlatform } | undefined;
  whitelist?: unknown;
};

/** Validación cruzada (tipo ↔ modpack, whitelist ↔ properties). */
export function contentCheck(s: ContentShape, ctx: z.RefinementCtx) {
  const typeIsPlatform = (MODPACK_PLATFORMS as readonly string[]).includes(s.type);
  if (s.modpack && s.type !== s.modpack.platform) {
    ctx.addIssue({ code: "custom", path: ["type"], message: `Un modpack de ${s.modpack.platform} requiere el tipo ${s.modpack.platform}` });
  }
  if (!s.modpack && typeIsPlatform) {
    ctx.addIssue({ code: "custom", path: ["modpack"], message: `El tipo ${s.type} requiere indicar el modpack` });
  }
  if (s.whitelist) {
    for (const k of WHITELIST_PROPS) {
      if (k in s.properties) {
        ctx.addIssue({ code: "custom", path: ["properties", k], message: `La propiedad ${k} se gestiona desde la sección Jugadores (whitelist)` });
      }
    }
  }
}

/** ¿La spec descarga algo de CurseForge? Solo entonces el panel le envía CF_API_KEY. */
export function usesCurseForge(s: { modpack?: { platform: string } | undefined; mods?: { curseforgeFiles: string[] } | undefined }): boolean {
  return s.modpack?.platform === "AUTO_CURSEFORGE" || (s.mods?.curseforgeFiles.length ?? 0) > 0;
}
