import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { docsPlugin } from "./build/vite-plugin-docs.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** Base path with a leading and a trailing slash ("/mcsm/"). */
const base = `/${(process.env.SITE_BASE ?? "/mcsm/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
/** Absolute site URL without a trailing slash. */
const siteUrl = (process.env.SITE_URL ?? "https://javilobo8.github.io/mcsm").replace(/\/+$/, "");
const version = fs.readFileSync(path.join(repoRoot, "agent/VERSION"), "utf8").trim();
const repoUrl = "https://github.com/javilobo8/mcsm";

/** Fills the absolute URLs of index.html (Open Graph needs them absolute). */
function siteHtml(): Plugin {
  return {
    name: "mcsm-site-html",
    transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", siteUrl),
  };
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), siteHtml(), docsPlugin({ repoRoot, base })],
  define: {
    __MCSM_VERSION__: JSON.stringify(version),
    __SITE_URL__: JSON.stringify(siteUrl),
    __REPO_URL__: JSON.stringify(repoUrl),
  },
  resolve: { alias: { "@": path.join(here, "src") } },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
