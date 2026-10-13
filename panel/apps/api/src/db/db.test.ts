import { describe, expect, it } from "vitest";
import { openDb, migrate } from "./db.js";

describe("db", () => {
  it("applies the migrations and is idempotent", () => {
    const db = openDb(":memory:");
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    for (const t of ["enrollment_tokens", "nodes", "schema_migrations", "servers", "sessions", "settings"]) {
      expect(tables).toContain(t);
    }
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(applied.n).toBeGreaterThan(0);
  });
  it("enables foreign keys", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO servers (id,node_id,name,slug,spec,created_at,updated_at) VALUES ('s','no-node','n','n','{}','t','t')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
