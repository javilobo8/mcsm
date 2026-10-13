import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../db/db.js";
import { prepareDataDir, restrictDbFiles } from "./data-dir.js";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("data directory permissions (L9)", () => {
  let base: string;
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("creates the directory with 0700 and fixes an existing, more open one", () => {
    base = mkdtempSync(join(tmpdir(), "mcsm-perm-"));
    const nuevo = join(base, "nuevo", "data");
    expect(prepareDataDir(nuevo)).toEqual([]);
    expect(mode(nuevo)).toBe(0o700);
    const viejo = join(base, "viejo");
    mkdirSync(viejo, { mode: 0o755 });
    chmodSync(viejo, 0o755);
    prepareDataDir(viejo);
    expect(mode(viejo)).toBe(0o700);
  });

  it("leaves panel.db and its -wal/-shm at 0600", () => {
    base = mkdtempSync(join(tmpdir(), "mcsm-perm-"));
    const dbPath = join(base, "panel.db");
    const db = openDb(dbPath);
    writeFileSync(`${dbPath}-shm`, "", { flag: "a" });
    expect(restrictDbFiles(dbPath)).toEqual([]);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(mode(p)).toBe(0o600);
    db.close();
  });

  it("ignores files that do not exist yet", () => {
    base = mkdtempSync(join(tmpdir(), "mcsm-perm-"));
    expect(restrictDbFiles(join(base, "no-existe.db"))).toEqual([]);
  });
});
