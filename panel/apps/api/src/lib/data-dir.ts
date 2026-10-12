import { chmodSync, existsSync, mkdirSync } from "node:fs";

/**
 * L9: la BD del panel guarda las rconPassword, el secreto de firma de las cookies y las
 * sesiones, así que su directorio es solo del usuario del panel (0700) y sus ficheros 0600.
 * Devuelven avisos en vez de fallar si no pueden cambiar permisos (p. ej. un bind mount ajeno).
 */
export function prepareDataDir(dir: string): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return restrict([dir], 0o700);
}

/** panel.db y sus -wal/-shm a 0600 (SQLite crea los nuevos con los permisos de la BD). */
export function restrictDbFiles(dbPath: string): string[] {
  return restrict([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p)), 0o600);
}

function restrict(paths: string[], mode: number): string[] {
  const warnings: string[] = [];
  for (const p of paths) {
    try {
      chmodSync(p, mode);
    } catch (e) {
      warnings.push(`no se pudieron restringir los permisos de ${p}: ${(e as Error).message}`);
    }
  }
  return warnings;
}
