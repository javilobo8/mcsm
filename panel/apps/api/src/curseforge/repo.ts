import type { Db } from "../db/db.js";

/** Key of the settings table where the global CurseForge API key lives (spec §4 settings). */
export const CURSEFORGE_KEY_SETTING = "curseforge_api_key";

/**
 * Global CurseForge API key. Stored in plain text (it has to be sent to the agents), never
 * returned by the API and never copied to servers.spec: it is added to the spec only in the message
 * to the agent (toServerSpecMessage) and only if the spec uses CurseForge.
 */
export class CurseForgeKeyRepo {
  constructor(private db: Db) {}

  get(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CURSEFORGE_KEY_SETTING) as { value: string } | undefined;
    return row?.value || null;
  }

  /** Saves the key ("" deletes it). Returns true if the value changed. */
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
