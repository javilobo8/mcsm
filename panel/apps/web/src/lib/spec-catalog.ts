/** Catalogs for the configuration form (English labels, itzg values). */

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
  { value: "MODRINTH", label: "Modrinth modpack", kind: "modpack" },
  { value: "AUTO_CURSEFORGE", label: "CurseForge modpack", kind: "modpack" },
  { value: "FTBA", label: "FTB modpack", kind: "modpack" },
];

export function typeKind(type: string): TypeKind {
  return SERVER_TYPES.find((t) => t.value === type)?.kind ?? "other";
}

export function typeLabel(type: string): string {
  return SERVER_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const JAVA_TAGS = ["java21", "java25", "java17", "java8", "latest"] as const;

export const RESTART_POLICIES: readonly { value: "unless-stopped" | "always" | "on-failure" | "no"; label: string }[] = [
  { value: "unless-stopped", label: "Unless I stop it (unless-stopped)" },
  { value: "always", label: "Always (always)" },
  { value: "on-failure", label: "Only on failure (on-failure)" },
  { value: "no", label: "Never (no)" },
];

export type PropKind = "text" | "int" | "bool" | "enum";
export interface PropDef { key: string; label: string; kind: PropKind; options?: readonly string[]; placeholder?: string; min?: number; max?: number }

/** The ~20 most used server.properties properties, with a typed field. The rest go in "Other". */
export const PROPERTY_DEFS: readonly PropDef[] = [
  { key: "motd", label: "MOTD (server list message)", kind: "text", placeholder: "Home server" },
  { key: "difficulty", label: "Difficulty", kind: "enum", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Game mode", kind: "enum", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "max-players", label: "Max players", kind: "int", min: 1, max: 1000, placeholder: "20" },
  { key: "view-distance", label: "View distance (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "simulation-distance", label: "Simulation distance (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "pvp", label: "PvP", kind: "bool" },
  { key: "hardcore", label: "Hardcore", kind: "bool" },
  { key: "online-mode", label: "Online mode (premium accounts)", kind: "bool" },
  { key: "allow-flight", label: "Allow flight", kind: "bool" },
  { key: "allow-nether", label: "Allow the Nether", kind: "bool" },
  { key: "spawn-protection", label: "Spawn protection (blocks)", kind: "int", min: 0, max: 1000, placeholder: "16" },
  { key: "level-name", label: "World name (folder)", kind: "text", placeholder: "world" },
  { key: "level-seed", label: "Seed", kind: "text" },
  { key: "level-type", label: "World type", kind: "enum", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"] },
  { key: "generate-structures", label: "Generate structures", kind: "bool" },
  { key: "spawn-monsters", label: "Monsters spawn", kind: "bool" },
  { key: "enable-command-block", label: "Command blocks", kind: "bool" },
  { key: "force-gamemode", label: "Force game mode on join", kind: "bool" },
  { key: "player-idle-timeout", label: "Kick when idle (minutes, 0 = never)", kind: "int", min: 0, max: 10000 },
  { key: "max-world-size", label: "Max world radius (blocks)", kind: "int", min: 1, max: 29999984 },
  { key: "enforce-secure-profile", label: "Require secure profile (signed chat)", kind: "bool" },
];

export const TYPED_PROPERTY_KEYS = new Set(PROPERTY_DEFS.map((d) => d.key));
