import { chmodSync, existsSync, mkdirSync } from "node:fs";

/**
 * L9: the panel DB stores the rconPasswords, the cookie signing secret and the
 * sessions, so its directory belongs only to the panel user (0700) and its files are 0600.
 * They return warnings instead of failing if they cannot change permissions (e.g. a foreign bind mount).
 */
export function prepareDataDir(dir: string): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return restrict([dir], 0o700);
}

/** panel.db and its -wal/-shm at 0600 (SQLite creates new ones with the DB's permissions). */
export function restrictDbFiles(dbPath: string): string[] {
  return restrict([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p)), 0o600);
}

function restrict(paths: string[], mode: number): string[] {
  const warnings: string[] = [];
  for (const p of paths) {
    try {
      chmodSync(p, mode);
    } catch (e) {
      warnings.push(`could not restrict the permissions of ${p}: ${(e as Error).message}`);
    }
  }
  return warnings;
}
