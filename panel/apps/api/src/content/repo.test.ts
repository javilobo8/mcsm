import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/db.js";
import { ContentMetaRepo } from "./repo.js";

/** The db, counting `exec`/`prepare` calls (to see transactions and statement preparation). */
function counted(db: Db) {
  const execs: string[] = [];
  let prepares = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "exec") return (sql: string) => { execs.push(sql); return target.exec(sql); };
      if (prop === "prepare") return (sql: string) => { prepares++; return target.prepare(sql); };
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, execs, prepares: () => prepares };
}

function setup() {
  let now = "2026-10-30T10:00:00.000Z";
  const repo = new ContentMetaRepo(openDb(":memory:"), () => Date.parse(now));
  return { repo, at: (iso: string) => { now = iso; } };
}

describe("ContentMetaRepo", () => {
  it("round-trips JSON data with its fetch time", () => {
    const t = setup();
    t.repo.put("modrinth", "project", "AABBCCDD", { name: "Sodium", tags: ["a"] });
    expect(t.repo.get("modrinth", "project", "AABBCCDD")).toEqual({ data: { name: "Sodium", tags: ["a"] }, fetchedAt: "2026-10-30T10:00:00.000Z" });
    expect(t.repo.get("curseforge", "project", "AABBCCDD")).toBeNull();
    expect(t.repo.get("modrinth", "version", "AABBCCDD")).toBeNull();
  });

  it("getMany returns only present ids", () => {
    const t = setup();
    t.repo.put("modrinth", "version", "a", 1);
    t.repo.put("modrinth", "version", "b", 2);
    const m = t.repo.getMany("modrinth", "version", ["a", "b", "c"]);
    expect([...m.keys()].sort()).toEqual(["a", "b"]);
    expect(m.get("b")!.data).toBe(2);
    expect(t.repo.getMany("modrinth", "version", []).size).toBe(0);
  });

  it("getMany handles more ids than one statement takes", () => {
    const t = setup();
    const ids = Array.from({ length: 1500 }, (_, i) => `id${i}`);
    for (const id of ids) t.repo.put("curseforge", "version", id, id);
    expect(t.repo.getMany("curseforge", "version", ids).size).toBe(1500);
  });

  it("put replaces the data and the fetch time", () => {
    const t = setup();
    t.repo.put("modrinth", "ref", "sodium", "AANRTDJ7");
    t.at("2026-10-31T10:00:00.000Z");
    t.repo.put("modrinth", "ref", "sodium", "BBBBBBBB");
    expect(t.repo.get("modrinth", "ref", "sodium")).toEqual({ data: "BBBBBBBB", fetchedAt: "2026-10-31T10:00:00.000Z" });
  });

  it("putMany writes every row in one transaction with the cached statement", () => {
    const c = counted(openDb(":memory:"));
    const repo = new ContentMetaRepo(c.db, () => Date.parse("2026-10-30T10:00:00.000Z"));
    const before = c.prepares();
    const rows = Array.from({ length: 1000 }, (_, i) => ({ kind: i % 2 ? "file" as const : "version" as const, id: `v${i}`, data: i }));
    repo.putMany("modrinth", rows);
    expect(c.execs).toEqual(["BEGIN", "COMMIT"]);
    expect(c.prepares()).toBe(before);
    expect(repo.getMany("modrinth", "version", ["v0", "v998"]).size).toBe(2);
    expect(repo.get("modrinth", "file", "v999")).toEqual({ data: 999, fetchedAt: "2026-10-30T10:00:00.000Z" });
    repo.putMany("modrinth", []);
    expect(c.execs).toEqual(["BEGIN", "COMMIT"]);
  });

  it("putMany writes nothing when one row fails", () => {
    const t = setup();
    expect(() => t.repo.putMany("modrinth", [{ kind: "version", id: "a", data: 1 }, { kind: "version", id: "b", data: 1n }])).toThrow();
    expect(t.repo.get("modrinth", "version", "a")).toBeNull();
    t.repo.put("modrinth", "version", "c", 3); // the connection is usable again (no transaction left open)
    expect(t.repo.get("modrinth", "version", "c")?.data).toBe(3);
  });

  it("purgeOlderThan deletes older rows and returns the count", () => {
    const t = setup();
    t.repo.put("modrinth", "project", "old1", 1);
    t.repo.put("modrinth", "version", "old2", 1);
    t.at("2026-12-01T00:00:00.000Z");
    t.repo.put("modrinth", "project", "new", 1);
    expect(t.repo.purgeOlderThan("2026-11-01T00:00:00.000Z")).toBe(2);
    expect(t.repo.get("modrinth", "project", "old1")).toBeNull();
    expect(t.repo.get("modrinth", "project", "new")).not.toBeNull();
  });
});
