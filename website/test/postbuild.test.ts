import { describe, it, expect } from "vitest";
import { renderRouteHtml, routePaths, sitemapXml, robotsTxt } from "../build/postbuild";

const tpl = `<html><head><title>MC Server Manager</title><meta name="description" content="x"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:url" content="x"><link rel="canonical" href="x"></head><body></body></html>`;
const site = "https://javilobo8.github.io/mcsm";

describe("postbuild", () => {
  it("renders per-route meta, escaped", () => {
    const html = renderRouteHtml(tpl, { path: "docs/backups/", title: 'Backups "hot" & cold', description: "<b>Hi</b>" }, site);
    expect(html).toContain("<title>Backups &quot;hot&quot; &amp; cold</title>");
    expect(html).toContain('<meta name="description" content="&lt;b&gt;Hi&lt;/b&gt;">');
    expect(html).toContain('<link rel="canonical" href="https://javilobo8.github.io/mcsm/docs/backups/">');
    expect(html).toContain('<meta property="og:url" content="https://javilobo8.github.io/mcsm/docs/backups/">');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });
  it("lists the routes", () => {
    expect(routePaths(["introduction", "backups"])).toEqual(["", "docs/", "docs/introduction/", "docs/backups/"]);
  });
  it("builds the sitemap and robots", () => {
    const xml = sitemapXml(site, ["", "docs/backups/"]);
    expect(xml).toContain("<loc>https://javilobo8.github.io/mcsm/</loc>");
    expect(xml).toContain("<loc>https://javilobo8.github.io/mcsm/docs/backups/</loc>");
    expect(robotsTxt(site)).toContain("Sitemap: https://javilobo8.github.io/mcsm/sitemap.xml");
  });
});

describe("writeRouteFiles", () => {
  it("writes the docs routes, the 404 fallback, the sitemap and robots", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { writeRouteFiles } = await import("../build/postbuild");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-dist-"));
    try {
      fs.writeFileSync(path.join(out, "index.html"), tpl);
      writeRouteFiles(out, [
        { slug: "introduction", title: "Introduction", description: "What it is." },
        { slug: "backups", title: "Backups", description: "Hot and cold." },
      ], site);
      const read = (p: string) => fs.readFileSync(path.join(out, p), "utf8");
      expect(read("docs/backups/index.html")).toContain("<title>Backups · MC Server Manager docs</title>");
      expect(read("docs/index.html")).toContain('<link rel="canonical" href="https://javilobo8.github.io/mcsm/docs/introduction/">');
      // The SPA fallback is the template, kept out of search results.
      expect(read("404.html")).toBe(tpl.replace("</head>", '<meta name="robots" content="noindex"></head>'));
      expect(read("sitemap.xml")).toContain("<loc>https://javilobo8.github.io/mcsm/docs/introduction/</loc>");
      expect(read("sitemap.xml")).not.toContain("<loc>https://javilobo8.github.io/mcsm/docs/</loc>");
      expect(read("robots.txt")).toContain("Sitemap:");
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  it("refuses a template without one of the tags", () => {
    expect(() => renderRouteHtml("<title>x</title>", { path: "", title: "t", description: "d" }, site)).toThrow(/description/);
  });
});
