import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadDocs } from "../build/docs/load";

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "src/content/docs");
const docs = await loadDocs(dir, { base: "/mcsm/", repoRoot: path.resolve(root, "..") });

describe.skipIf(docs.length === 0)("docs content", () => {
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  it("has the introduction page", () => expect(bySlug.has("introduction")).toBe(true));
  it.each(docs.map((d) => [d.slug, d] as const))("%s: internal links resolve", (_slug, d) => {
    for (const link of d.links) {
      const [, slug, anchor] = /^\/docs\/([^#/]+)\/?(?:#(.+))?$/.exec(link) ?? [];
      expect(slug, `bad link ${link}`).toBeTruthy();
      const target = bySlug.get(slug!);
      expect(target, `missing page ${link}`).toBeDefined();
      if (anchor) expect(target!.headingIds, `missing anchor ${link}`).toContain(anchor);
    }
  });
  it.each(docs.map((d) => [d.slug, d] as const))("%s: images exist", (_slug, d) => {
    for (const img of d.images) expect(fs.existsSync(path.join(root, "public", img)), img).toBe(true);
  });
});
