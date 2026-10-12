import type { Db } from "../db/db.js";

/** Clave de la tabla settings donde vive la API key global de CurseForge (spec §4 settings). */
export const CURSEFORGE_KEY_SETTING = "curseforge_api_key";

/**
 * API key global de CurseForge. Se guarda en claro (hay que enviarla a los agentes), nunca se
 * devuelve por la API y nunca se copia a servers.spec: se añade a la spec solo en el mensaje
 * hacia el agente (toServerSpecMessage) y solo si la spec usa CurseForge.
 */
export class CurseForgeKeyRepo {
  constructor(private db: Db) {}

  get(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CURSEFORGE_KEY_SETTING) as { value: string } | undefined;
    return row?.value || null;
  }

  /** Guarda la key ("" la borra). Devuelve true si el valor cambió. */
  set(apiKey: string): boolean {
    if ((this.get() ?? "") === apiKey) return false;
    if (apiKey === "") this.db.prepare("DELETE FROM settings WHERE key = ?").run(CURSEFORGE_KEY_SETTING);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CURSEFORGE_KEY_SETTING, apiKey);
    return true;
  }
}

declare module "fastify" {
  interface FastifyInstance { curseforge: CurseForgeKeyRepo }
}
