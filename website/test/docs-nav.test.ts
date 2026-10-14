import { describe, it, expect } from "vitest";
import { sortPages, groupBySection, neighbours } from "../src/lib/docs-nav";

const p = (slug: string, section: string, order: number) => ({ slug, title: slug, section, order });
const pages = [p("backups", "Guides", 50), p("intro", "Getting started", 10), p("install", "Getting started", 20), p("security", "Operations", 90)];

describe("docs-nav", () => {
  it("sorts by order", () => {
    expect(sortPages(pages).map((x) => x.slug)).toEqual(["intro", "install", "backups", "security"]);
  });
  it("throws on a duplicate order naming both pages", () => {
    expect(() => sortPages([p("a", "Guides", 1), p("b", "Guides", 1)])).toThrow(/a.*b|b.*a/);
  });
  it("groups sections in the order of their first page", () => {
    expect(groupBySection(sortPages(pages)).map((g) => [g.section, g.pages.map((x) => x.slug)])).toEqual([
      ["Getting started", ["intro", "install"]],
      ["Guides", ["backups"]],
      ["Operations", ["security"]],
    ]);
  });
  it("gives prev/next across sections and none at the ends", () => {
    const s = sortPages(pages);
    expect(neighbours(s, "install")).toEqual({ prev: s[0], next: s[2] });
    expect(neighbours(s, "intro").prev).toBeUndefined();
    expect(neighbours(s, "security").next).toBeUndefined();
    expect(neighbours(s, "nope")).toEqual({});
  });
});
