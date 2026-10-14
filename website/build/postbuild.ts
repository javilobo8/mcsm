import fs from "node:fs";
import path from "node:path";
import { docTitle } from "../src/lib/doc-title.ts";

/** `path` is relative to the base: "", "docs/", "docs/backups/". */
export interface RouteMeta {
  path: string;
  title: string;
  description: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const escapeXml = escapeHtml;

/** Replaces exactly one tag; a template without it is a build error, not a page with stale meta. */
function replaceOne(html: string, pattern: RegExp, what: string, tag: string): string {
  let found = 0;
  const out = html.replace(new RegExp(pattern.source, "g"), () => {
    found++;
    return tag;
  });
  if (found !== 1) throw new Error(`index.html must contain exactly one ${what} (found ${found})`);
  return out;
}

/** Replaces title, description, og:title, og:description, og:url and canonical in the template. Values are HTML-escaped. */
export function renderRouteHtml(template: string, route: RouteMeta, siteUrl: string): string {
  const url = escapeHtml(`${siteUrl}/${route.path}`);
  const title = escapeHtml(route.title);
  const description = escapeHtml(route.description);
  let html = template;
  html = replaceOne(html, /<title>[\s\S]*?<\/title>/, "<title>", `<title>${title}</title>`);
  html = replaceOne(html, /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/, `<meta name="description">`, `<meta name="description" content="${description}">`);
  html = replaceOne(html, /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/, `<meta property="og:title">`, `<meta property="og:title" content="${title}">`);
  html = replaceOne(html, /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/, `<meta property="og:description">`, `<meta property="og:description" content="${description}">`);
  html = replaceOne(html, /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?>/, `<meta property="og:url">`, `<meta property="og:url" content="${url}">`);
  html = replaceOne(html, /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/, `<link rel="canonical">`, `<link rel="canonical" href="${url}">`);
  return html;
}

/** "" and "docs/" plus "docs/<slug>/" for every page. */
export function routePaths(slugs: string[]): string[] {
  return ["", "docs/", ...slugs.map((s) => `docs/${s}/`)];
}

export function sitemapXml(siteUrl: string, paths: string[]): string {
  const urls = paths.map((p) => `  <url><loc>${escapeXml(`${siteUrl}/${p}`)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
}


/**
 * Writes, next to the built `index.html`: one `index.html` per docs route with its own meta, `docs/index.html`
 * (meta of the introduction, which it redirects to), `404.html` (the SPA fallback GitHub Pages serves for any
 * unknown path), `sitemap.xml` and `robots.txt`.
 */
export function writeRouteFiles(outDir: string, pages: { slug: string; title: string; description: string }[], siteUrl: string): void {
  const template = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  const write = (rel: string, content: string) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  const intro = pages.find((p) => p.slug === "introduction") ?? pages[0];
  write(
    "docs/index.html",
    intro
      ? renderRouteHtml(template, { path: `docs/${intro.slug}/`, title: docTitle(intro.title), description: intro.description }, siteUrl)
      : template,
  );
  for (const p of pages) {
    write(`docs/${p.slug}/index.html`, renderRouteHtml(template, { path: `docs/${p.slug}/`, title: docTitle(p.title), description: p.description }, siteUrl));
  }
  write("404.html", template);
  // "docs/" only redirects to the introduction: its canonical is the introduction, so it stays out of the sitemap.
  write("sitemap.xml", sitemapXml(siteUrl, routePaths(pages.map((p) => p.slug)).filter((p) => p !== "docs/")));
  write("robots.txt", robotsTxt(siteUrl));
}
