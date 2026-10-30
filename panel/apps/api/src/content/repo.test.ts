import { describe, expect, it } from "vitest";
import { openDb } from "../db/db.js";
import { ContentMetaRepo } from "./repo.js";

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
