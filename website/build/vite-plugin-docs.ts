import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { loadDocs, type LoadedDoc } from "./docs/load.ts";
import { webpSize } from "./docs/image-size.ts";
import { writeRouteFiles } from "./postbuild.ts";

export interface DocsPluginOptions {
  /** Directory of the Markdown pages; default `src/content/docs`, or `DOCS_DIR` (relative to the Vite root). */
  dir?: string;
  /** Absolute path of the repository root (includes are resolved under `<repoRoot>/deploy/`). */
  repoRoot: string;
  /** Base path with a trailing slash, e.g. "/mcsm/". */
  base: string;
  /** Absolute site URL without a trailing slash, for canonical URLs, the sitemap and robots.txt. */
  siteUrl: string;
}

const VIRTUAL_ID = "virtual:docs";
const RESOLVED_ID = "\0virtual:docs";

/** What the browser gets: the page minus the build-time bookkeeping. */
function toModule(docs: LoadedDoc[]): string {
  const pages = docs.map(({ slug, title, description, section, order, html, toc }) => ({ slug, title, description, section, order, html, toc }));
  return `export const pages = ${JSON.stringify(pages)};\n`;
}

/**
 * Compiles the Markdown documentation at build time and exposes it as `virtual:docs`.
 * In dev, editing, adding or removing a page (or an included file) reloads the browser. After a build it
 * writes the per-route files (see postbuild.ts).
 */
export function docsPlugin(options: DocsPluginOptions): Plugin {
  let root = process.cwd();
  let isBuild = false;
  let outDir = "dist";
  let publicDir = "public";
  let docs: LoadedDoc[] | undefined;
  const included = new Set<string>();

  const docsDir = () => path.resolve(root, options.dir ?? process.env.DOCS_DIR ?? "src/content/docs");

  async function load(): Promise<LoadedDoc[]> {
    included.clear();
    docs = await loadDocs(docsDir(), {
      base: options.base,
      repoRoot: options.repoRoot,
      readFile: (abs) => {
        included.add(abs);
        return fs.readFileSync(abs, "utf8");
      },
      imageSize: (src) => {
        const file = path.resolve(publicDir, `.${src}`);
        if (!src.startsWith("/") || !src.endsWith(".webp") || !file.startsWith(publicDir + path.sep)) return undefined;
        try {
          return webpSize(fs.readFileSync(file));
        } catch {
          return undefined;
        }
      },
    });
    return docs;
  }

  return {
    name: "mcsm-docs",
    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
      outDir = path.resolve(config.root, config.build.outDir);
      if (config.publicDir) publicDir = config.publicDir;
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const loaded = await load();
      const dir = docsDir();
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) if (name.endsWith(".md")) this.addWatchFile(path.join(dir, name));
      }
      for (const file of included) this.addWatchFile(file);
      return toModule(loaded);
    },
    // After the bundle is written: per-route HTML, the 404 fallback, the sitemap and robots.txt.
    async closeBundle() {
      if (!isBuild) return;
      writeRouteFiles(outDir, docs ?? (await load()), options.siteUrl);
    },
    configureServer(server) {
      const dir = docsDir();
      server.watcher.add(dir);
      const onChange = (file: string) => {
        const abs = path.resolve(file);
        const isPage = path.dirname(abs) === dir && abs.endsWith(".md");
        if (!isPage && !included.has(abs)) return;
        const graph = server.environments.client.moduleGraph;
        const mod = graph.getModuleById(RESOLVED_ID);
        if (mod) graph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
  };
}
