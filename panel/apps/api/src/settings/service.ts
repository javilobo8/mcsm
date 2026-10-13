import { CURSEFORGE_API_KEY_RE, portRangeSchema, type PortRange, type SettingsDto, type SettingsPut } from "@mcsm/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";

export const PUBLIC_URL_SETTING = "public_url";
export const PORT_RANGE_SETTING = "game_port_range";

/** State of the CurseForge API key: migration 020 copied the env value without validating it. */
export function curseforgeStatus(key: string | null): { configured: boolean; valid: boolean } {
  return { configured: key !== null, valid: key === null || (key.length <= 200 && CURSEFORGE_API_KEY_RE.test(key)) };
}

/** Panel settings (spec §8) in the settings table; the environment provides the defaults. */
export class SettingsService {
  constructor(private db: Db, private cfg: Config) {}

  private get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private set(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The panel's URL: the one in Settings or, if none, PANEL_PUBLIC_URL ("" = that of the browser requesting the command). */
  publicUrl(): string {
    return this.get(PUBLIC_URL_SETTING) ?? this.cfg.publicUrl;
  }

  /** Range of game ports that gets allocated; an unreadable stored one falls back to the configuration's. */
  gamePortRange(): PortRange {
    const raw = this.get(PORT_RANGE_SETTING);
    if (raw) {
      try {
        const r = portRangeSchema.safeParse(JSON.parse(raw));
        if (r.success) return r.data;
      } catch { /* broken JSON: the configuration's */ }
    }
    return { ...this.cfg.gamePortRange };
  }

  update(input: SettingsPut): void {
    if (input.publicUrl !== undefined) this.set(PUBLIC_URL_SETTING, input.publicUrl === "" ? null : input.publicUrl);
    if (input.gamePortRange !== undefined) this.set(PORT_RANGE_SETTING, JSON.stringify(input.gamePortRange));
  }

  dto(curseforgeKey: string | null): SettingsDto {
    const stored = this.get(PUBLIC_URL_SETTING);
    return {
      publicUrl: this.publicUrl(),
      publicUrlSource: stored !== null ? "settings" : this.cfg.publicUrl ? "env" : "request",
      envPublicUrl: this.cfg.publicUrl,
      gamePortRange: this.gamePortRange(),
      defaultGamePortRange: { ...this.cfg.gamePortRange },
      curseforge: curseforgeStatus(curseforgeKey),
    };
  }
}
