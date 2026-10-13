import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso, plusSeconds } from "../lib/time.js";

export class AuthRepo {
  constructor(private db: Db) {}
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  /** Inserta solo si la clave no existe. Devuelve true si la fila se insertó. */
  setSettingIfAbsent(key: string, value: string): boolean {
    const r = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").run(key, value);
    return r.changes === 1;
  }
  createSession(ttlSeconds: number): string {
    const id = newId();
    this.db.prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)").run(id, nowIso(), plusSeconds(ttlSeconds));
    return id;
  }
  getSession(id: string): boolean {
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id) as { expires_at: string } | undefined;
    return !!row && row.expires_at > nowIso();
  }
  /** Cierra todas las sesiones (cambio de contraseña). */
  deleteAllSessions(): void {
    this.db.prepare("DELETE FROM sessions").run();
  }
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  purgeExpired(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  }
}
