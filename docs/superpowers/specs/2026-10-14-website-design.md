# Project website — Design

Date: 2026-10-14
Status: design approved in conversation, pending written review

## 1. Goal

A public, open-source project website for MC Server Manager, deployed to GitHub Pages by its
own workflow: an eye-catching single-page application that presents the product and carries
documentation complete enough to install, operate and contribute without reading the README.
English only. MIT, like the rest of the repository.

URL: `https://javilobo8.github.io/mcsm/` (the repository is `javilobo8/mcsm`; Pages is enabled by
the owner with source **GitHub Actions**).

Out of scope (YAGNI): a light theme, i18n, a blog, analytics, a GitHub stars counter (runtime API
calls), server-side rendering of page bodies, a custom domain (the base path stays configurable).

## 2. Decisions

| Topic | Decision |
|---|---|
| Stack | Vite + React 19 + TypeScript strict + Tailwind 4 + shadcn (Radix, `pnpm dlx shadcn@3.8.5`), lucide-react, `motion` for animation, TanStack Router (as in the panel), cmdk for search. |
| Location | `website/`, its own pnpm project with its own `pnpm-workspace.yaml` and `pnpm-lock.yaml`. It is NOT part of the root workspace: the panel's Docker build and the root `pnpm typecheck/test` stay untouched. |
| Docs | Markdown files compiled to HTML at build time by a local Vite plugin (unified: remark-parse, remark-gfm, remark-frontmatter, remark-rehype, rehype-slug with GitHub slugs, shiki). No Markdown parser in the browser bundle. |
| Routing | Path routes under the base `/mcsm/`. A post-build step writes one `index.html` per route with its own title/description, a `404.html` SPA fallback, `sitemap.xml` and `robots.txt`. |
| Theme | Dark only, matching the panel. Minecraft touches without going full game UI. |
| Deployment | `.github/workflows/pages.yml` with the official Pages actions, pinned by SHA. |

## 3. Visual direction

Dark base (near-black, like the panel) with a grass/emerald accent and a secondary warm accent
used sparingly (e.g. gold/torch). Recognisably Minecraft but professional:

- Hero background: a voxel/isometric block grid or floating blocks, with a soft glow; subtle
  parallax or float animation.
- A pixel font (e.g. Silkscreen or Pixelify Sans, self-hosted via `@fontsource`) only for a few
  headline accents or labels; body in Geist or Inter; code in JetBrains Mono. All fonts bundled
  (no Google Fonts requests).
- Real product screenshots (from the E2E run) in a browser-window frame with glow.
- Scroll-reveal and hover micro-interactions with `motion`; everything respects
  `prefers-reduced-motion`.
- Responsive down to 390 px wide; no horizontal scroll; keyboard-accessible; visible focus;
  WCAG AA contrast for text.
- Favicon: an SVG voxel block. `og:image`: a 1200×630 social card (PNG) built from a screenshot.

## 4. Landing page (`/`)

In order:

1. **Navbar** (sticky, blurred): logo, Features, How it works, Docs, GitHub link, current version
   badge (`v` + `agent/VERSION`, read at build time, linking to the releases page), “Get started”
   button. Mobile: a Sheet menu.
2. **Hero**: headline and subheadline (one panel for every Minecraft Java server on your LAN's
   Docker machines), CTAs “Get started” (`/docs/installation`) and “View on GitHub”; a copyable
   one-line install snippet; badges (MIT, Docker, amd64 + arm64, itzg/minecraft-server); the
   dashboard screenshot in a browser frame.
3. **Features** (bento grid): any server the itzg image runs (types, versions, mods, modpacks);
   live console and 7-day metrics; hot and scheduled backups with restore; file manager;
   migration between nodes; import of existing itzg containers; mc-router hostnames with
   autoscale; templates (save a server as a template, create new ones from it); crash-loop protection, events and jobs; multi-node with
   one agent per machine.
4. **How it works**: an animated SVG diagram — panel (Fastify API + React web + SQLite) and
   agents (Go) per node; agents connect outbound over WebSocket with protobuf and never listen;
   the panel is the source of truth and each agent reconciles Docker to the desired specs.
5. **Screenshot tour**: tabs (Overview, Console, Configuration, Backups, Files, Migrate, Nodes,
   …) showing the real screenshots with a one-line caption each.
6. **Quick start**: three steps (create the network and start the compose on the main machine;
   open the panel and finish setup with the setup token; add nodes with the command from
   **Add node**), each with a copyable snippet, linking to the docs.
7. **Security by design**: hardened containers (no capabilities beyond the itzg minimum,
   `no-new-privileges`, limits), agents never listen, filtered Docker socket for mc-router —
   and the honest caveats: built for a trusted home LAN, single administrator, no TLS, Docker
   is root-equivalent.
8. **Open source**: MIT, the stack (Go, TypeScript, React, Fastify, SQLite, protobuf/buf,
   Docker), links to the repository, issues and the development docs.
9. **Footer**: links, license, “Minecraft is a trademark of Mojang; not affiliated” notice.

All facts must match the README and the code; nothing is invented (no fake testimonials,
download counts or stars).

## 5. Documentation (`/docs/<slug>`)

Layout: left sidebar grouped by section (collapsible into a Sheet on mobile), content column,
right “On this page” TOC (h2/h3) with scroll-spy on wide screens, previous/next links at the
bottom, “Edit this page on GitHub” link. `/docs` redirects to `/docs/introduction`.
A ⌘K / Ctrl+K search dialog (cmdk) over page titles, descriptions and h2/h3 headings, opening
the page at the anchor. Code blocks have a copy button and a language label.

### 5.1 Pages

| Section | Slug | Content (source: README, verified against the code) |
|---|---|---|
| Getting started | `introduction` | What it is, architecture overview, features, requirements, what it doesn't do |
| Getting started | `installation` | Main machine (panel + agent): network, compose, `.env`, first start, setup token, password, enrolling the local agent |
| Getting started | `adding-nodes` | Other machines: node compose or the `docker run` from **Add node**; rotating a node's token |
| Getting started | `updating` | Updating, version pinning, panel database backup |
| Guides | `servers` | Creating (wizard, templates, types, versions, builds), configuration, console, power actions, connection address, metrics (there is no clone feature) |
| Guides | `backups` | Backups, schedules, retention, restore, pre-restore data, server locked without `data`, space, simultaneous jobs, stopping the agent |
| Guides | `files` | File manager, upload limits, transfers |
| Guides | `migration` | Migration between nodes |
| Guides | `importing` | Importing existing servers |
| Guides | `router` | mc-router: hostnames, autoscale, caveats |
| Guides | `events` | Events, crash loops, jobs |
| Operations | `settings` | Settings, ports and firewall |
| Operations | `security` | Security model and caveats |
| Project | `development` | Development setup, tests, E2E, protocol, CI and releases, contributing |

### 5.2 Content contract (between the app and the content)

Files: `website/src/content/docs/<slug>.md`, one per page.

Frontmatter (all required):

```yaml
---
title: Backups
description: One sentence, used as meta description and in search.
section: Guides          # Getting started | Guides | Operations | Project
order: 50                # global order; sections appear in the order of their first page
---
```

Body rules:

- No `#` (h1): the title comes from the frontmatter. `##`/`###` build the TOC; anchors are
  GitHub-style slugs of the heading text.
- Internal links: `/docs/<slug>` or `/docs/<slug>#<anchor>` (the pipeline adds the base path).
  A test fails the build if a target page or anchor does not exist.
- Callouts: GitHub alert syntax `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
  `> [!CAUTION]`.
- Includes: a fenced block with an empty body and `include="<path from repo root>"` in its
  meta is replaced with that file's content at build time, e.g.
  ```` ```yaml include="deploy/docker-compose.yml" ```` followed by the closing fence. Only `deploy/docker-compose.yml`,
  `deploy/docker-compose.node.yml` and `deploy/.env.example` are allowed (an allowlist, so the
  gitignored `deploy/.env` can never be pulled in; symlinks out of `deploy/` are refused), so
  the docs never drift.
- Images: `![alt](/screenshots/<name>.webp)`, where `<name>` is the basename of a file in
  `panel/apps/e2e/screenshots/` (e.g. `06-backups`). A test fails the build if it doesn't exist.
- External links are absolute `https://` URLs (rendered with `target="_blank" rel="noopener"`).
- The `docker run` from **Add node** is a literal copy of the one in the README (generated by
  `dockerRunSnippet`); CLAUDE.md's note about keeping the README in sync extends to
  `website/src/content/docs/adding-nodes.md`.

## 6. Build pipeline

- `website/vite.config.ts`: `base` from `SITE_BASE` (default `/mcsm/`); `define` for the version
  (`agent/VERSION`) and the site URL (`SITE_URL`, default `https://javilobo8.github.io/mcsm`).
- Docs plugin (`website/build/`): loads every `src/content/docs/*.md`, validates the frontmatter
  (zod), resolves includes, compiles to HTML with shiki (dark theme, only the languages used:
  bash, yaml, ini/dotenv, json, ts, go, text), rewrites internal links and images with the base,
  turns alerts into callout markup, extracts the TOC and the search index, and exposes a virtual
  module (`virtual:docs`) with `{ pages: [{ slug, title, description, section, order, html, toc }] }`.
  HTML is trusted (it is our own content) and rendered with `dangerouslySetInnerHTML`.
- Post-build (in the same plugin, `closeBundle`): `dist/docs/<slug>/index.html` and
  `dist/docs/index.html` from `dist/index.html` with per-page `<title>`, meta description,
  canonical and Open Graph tags; `dist/404.html` (SPA fallback); `dist/sitemap.xml`;
  `dist/robots.txt`.
- Screenshots: selected PNGs from `panel/apps/e2e/screenshots/` converted once to WebP
  (`magick`, quality ~82) and committed under `website/public/screenshots/`.

## 7. Deployment workflow

`.github/workflows/pages.yml`:

- Triggers: `push` to `main` touching `website/**`, `deploy/docker-compose.yml`,
  `deploy/docker-compose.node.yml`, `deploy/.env.example` or the workflow itself;
  `pull_request` with the same paths (build only); `workflow_run` of `Release` completed with
  success (so the version badge follows releases — it runs on the default branch, which the
  `github-pages` environment accepts; a `release` trigger would run on the tag and be rejected);
  `workflow_dispatch`.
- Top-level `permissions: contents: read`. Build job: checkout (`persist-credentials: false`),
  `pnpm/action-setup` (version from `website/package.json`), `actions/setup-node` 26,
  `pnpm install --frozen-lockfile`, `typecheck`, `test`, `build` (in `website/`), then
  `actions/upload-pages-artifact` with `website/dist` except on pull requests.
- Deploy job (not on pull requests): `needs: build`, `permissions: pages: write, id-token: write`,
  `environment: github-pages` with the page URL, `actions/deploy-pages`.
- Concurrency: deployments share one group without cancelling; PR builds cancel older runs of
  the same PR.
- Every action pinned by full SHA with a `# vX.Y.Z` comment, as in `ci.yml`.

## 8. Testing

- Vitest (node, no jsdom) for all logic: frontmatter validation, includes (and the `deploy/`
  restriction), link and image rewriting, alerts, TOC extraction, docs ordering/grouping and
  prev/next, search index, per-route HTML generation.
- A content test over the real docs: every internal link targets an existing page and anchor,
  every image exists in `public/screenshots/`, every page has unique `order`.
- `pnpm typecheck`, `pnpm test` and `pnpm build` in `website/` pass, with clean output.
- Visual check: screenshots of the built site (landing desktop 1440 px and mobile 390 px, one
  docs page desktop and mobile, the search dialog) taken with Playwright in a container named
  `mcsm-test-site-*` that serves `website/dist` itself (nftables drops container → host
  traffic), removed afterwards.

## 9. Execution

Two parallel tracks in separate worktrees (at most 2 subagents at a time):

- **App** (`web-ui-dev`, Opus): scaffold, docs pipeline, landing, docs shell, search,
  post-build, screenshots, tests, visual check.
- **Content** (`docs-writer`, Sonnet): the 14 Markdown pages under the content contract.

The controller writes the workflow, merges both tracks, then one `task-reviewer` pass, one fix
batch, and a final Opus review that also covers the workflow's security; merge to `main`
without pushing.
