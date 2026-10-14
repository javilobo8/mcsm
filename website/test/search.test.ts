import { describe, it, expect } from "vitest";
import { buildSearchIndex, search } from "../src/lib/search";

const index = buildSearchIndex([
  { slug: "backups", title: "Backups", description: "Hot and scheduled backups, restore.", section: "Guides",
    toc: [{ id: "restoring-and-pre-restore-data", text: "Restoring and pre-restore data" }, { id: "space", text: "Space, files and simultaneous jobs" }] },
  { slug: "router", title: "Router (mc-router)", description: "Join servers by hostname.", section: "Guides",
    toc: [{ id: "autoscale", text: "Autoscale" }] },
]);

describe("search", () => {
  it("indexes pages and their headings", () => {
    expect(index.filter((e) => e.slug === "backups")).toHaveLength(3);
    expect(index.find((e) => e.anchor === "autoscale")).toMatchObject({ page: "Router (mc-router)", title: "Autoscale" });
  });
  it("is case-insensitive and ranks title matches first", () => {
    const r = search(index, "BACKUPS");
    expect(r[0]).toMatchObject({ slug: "backups", anchor: undefined });
  });
  it("requires every word to match", () => {
    expect(search(index, "restore data").map((e) => e.anchor)).toContain("restoring-and-pre-restore-data");
    expect(search(index, "restore autoscale")).toEqual([]);
  });
  it("returns [] for blank or unmatched queries and honours the limit", () => {
    expect(search(index, "   ")).toEqual([]);
    expect(search(index, "zzzz")).toEqual([]);
    expect(search(index, "e", 2)).toHaveLength(2);
  });
});
