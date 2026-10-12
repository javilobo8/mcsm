/** Catálogos para el formulario de configuración (etiquetas en castellano, valores itzg). */

export type TypeKind = "vanilla" | "plugins" | "mods" | "modpack" | "other";

export const SERVER_TYPES: readonly { value: string; label: string; kind: TypeKind }[] = [
  { value: "VANILLA", label: "Vanilla", kind: "vanilla" },
  { value: "PAPER", label: "Paper", kind: "plugins" },
  { value: "PURPUR", label: "Purpur", kind: "plugins" },
  { value: "SPIGOT", label: "Spigot", kind: "plugins" },
  { value: "FOLIA", label: "Folia", kind: "plugins" },
  { value: "FABRIC", label: "Fabric", kind: "mods" },
  { value: "FORGE", label: "Forge", kind: "mods" },
  { value: "NEOFORGE", label: "NeoForge", kind: "mods" },
  { value: "QUILT", label: "Quilt", kind: "mods" },
  { value: "MODRINTH", label: "Modpack de Modrinth", kind: "modpack" },
  { value: "AUTO_CURSEFORGE", label: "Modpack de CurseForge", kind: "modpack" },
  { value: "FTBA", label: "Modpack de FTB", kind: "modpack" },
];

export function typeKind(type: string): TypeKind {
  return SERVER_TYPES.find((t) => t.value === type)?.kind ?? "other";
}

export function typeLabel(type: string): string {
  return SERVER_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const JAVA_TAGS = ["java21", "java25", "java17", "java8", "latest"] as const;

export const RESTART_POLICIES: readonly { value: "unless-stopped" | "always" | "on-failure" | "no"; label: string }[] = [
  { value: "unless-stopped", label: "Salvo si lo paro yo (unless-stopped)" },
  { value: "always", label: "Siempre (always)" },
  { value: "on-failure", label: "Solo si falla (on-failure)" },
  { value: "no", label: "Nunca (no)" },
];

export type PropKind = "text" | "int" | "bool" | "enum";
export interface PropDef { key: string; label: string; kind: PropKind; options?: readonly string[]; placeholder?: string; min?: number; max?: number }

/** Las ~20 propiedades de server.properties más usadas, con campo tipado. El resto va en "Otras". */
export const PROPERTY_DEFS: readonly PropDef[] = [
  { key: "motd", label: "MOTD (mensaje de la lista)", kind: "text", placeholder: "Servidor de casa" },
  { key: "difficulty", label: "Dificultad", kind: "enum", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Modo de juego", kind: "enum", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "max-players", label: "Jugadores máximos", kind: "int", min: 1, max: 1000, placeholder: "20" },
  { key: "view-distance", label: "Distancia de visión (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "simulation-distance", label: "Distancia de simulación (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "pvp", label: "PvP", kind: "bool" },
  { key: "hardcore", label: "Hardcore", kind: "bool" },
  { key: "online-mode", label: "Modo online (cuentas premium)", kind: "bool" },
  { key: "allow-flight", label: "Permitir volar", kind: "bool" },
  { key: "allow-nether", label: "Permitir el Nether", kind: "bool" },
  { key: "spawn-protection", label: "Protección del spawn (bloques)", kind: "int", min: 0, max: 1000, placeholder: "16" },
  { key: "level-name", label: "Nombre del mundo (carpeta)", kind: "text", placeholder: "world" },
  { key: "level-seed", label: "Semilla", kind: "text" },
  { key: "level-type", label: "Tipo de mundo", kind: "enum", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"] },
  { key: "generate-structures", label: "Generar estructuras", kind: "bool" },
  { key: "spawn-monsters", label: "Aparecen monstruos", kind: "bool" },
  { key: "enable-command-block", label: "Bloques de comandos", kind: "bool" },
  { key: "force-gamemode", label: "Forzar modo de juego al entrar", kind: "bool" },
  { key: "player-idle-timeout", label: "Expulsar por inactividad (minutos, 0 = nunca)", kind: "int", min: 0, max: 10000 },
  { key: "max-world-size", label: "Radio máximo del mundo (bloques)", kind: "int", min: 1, max: 29999984 },
  { key: "enforce-secure-profile", label: "Exigir perfil seguro (chat firmado)", kind: "bool" },
];

export const TYPED_PROPERTY_KEYS = new Set(PROPERTY_DEFS.map((d) => d.key));
