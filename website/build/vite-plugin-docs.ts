import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { loadDocs, type LoadedDoc } from "./docs/load.ts";

export interface DocsPluginOptions {
  /** Directory of the Markdown pages; default `src/content/docs`, or `DOCS_DIR` (relative to the Vite root). */
  dir?: string;
  /** Absolute path of the repository root (includes are resolved under `<repoRoot>/deploy/`). */
  repoRoot: string;
  /** Base path with a trailing slash, e.g. "/mcsm/". */
  base: string;
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
 * In dev, editing, adding or removing a page (or an included file) reloads the browser.
 */
export function docsPlugin(options: DocsPluginOptions): Plugin {
  let root = process.cwd();
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
    });
    return docs;
  }

  return {
    name: "mcsm-docs",
    configResolved(config) {
      root = config.root;
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
