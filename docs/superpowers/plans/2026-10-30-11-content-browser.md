# Plan 11 — Content browser (mods, plugins, datapacks, modpacks)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse Modrinth and CurseForge from a server's "Version and mods" tab, add only compatible content (dependencies included, pinned to exact versions), manage it as an installed list with updates and removal, and give modpacks a full lifecycle (install, change version, switch, uninstall) that keeps the world.

**Architecture:** The spec stays the single source of truth: the browser only edits the same string lists (`mods.*`, `plugins.*`, the new `datapacks` section, `modpack`) in the unsaved Configuration form, and Save applies them with one PATCH (optionally chained after a backup job on the panel). The panel gets a content catalog (`app.content`, sibling of `app.versions`) with Modrinth and CurseForge adapters, a SQLite cache of project/version/pack metadata, dependency resolution, update checks and an image proxy. The agent deletes the outgoing pack's files (from itzg's manifest under `/data`) when a pack is uninstalled or replaced by one on another platform, under the per-server lock, before the new container is created.

**Tech Stack:** Go 1.27 (agent, bbolt, `os.Root`), TypeScript strict + zod 4 (shared), Fastify 5 + `node:sqlite` (API), `fflate` 0.8.3 (zip), `marked` 18.1.1 + `sanitize-html` 2.18.1 (descriptions, API side), React 19 + TanStack Query + shadcn (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-content-browser-design.md` (amends §4.1 of `2026-10-12-mc-server-manager-design.md`). Its section "Calls made by the designer after the builder check" overrides the earlier parts of the same document; this plan follows the calls.

## Global Constraints

- English UI/error messages and identifiers. Conventional commits, small, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (Opus 5.5 when the implementer is `systems-expert`). Never `git push`, `--no-verify` or history rewrites.
- TDD: failing test → minimal code → passing test → commit. Clean output. Tests never touch the network or real time: injected `fetch`, `now`, `ManualTimers` (`panel/apps/api/test/manual-timers.ts`); Go uses `t.TempDir()`, the `docker.Fake` and the reconciler `setup(t)` helper.
- **No existing server changes container or `mcsm.spec_hash`.** `TestHashGolden`/`TestContentHash` stay at `09ff6e5490b40677` untouched. Absent `datapacks` and absent/empty `plugins.curseforgeFiles` emit nothing.
- Go/zod parity through `proto/fixtures/spec-content-cases.json` (new cases appended; both sides already iterate it). Caps unchanged: lists ≤ 1000 (`MAX_LIST_ITEMS`/`MaxListItems`), entries `ENTRY_RE` `^[!-+\--~]{1,300}$`, serialized spec ≤ 64 KiB.
- Every spec change goes through `serversService.patch` (also the chained "Back up first" apply). Never `servers.updateSpec` from another service.
- The CurseForge key is read only with `app.curseforge.get()` inside the API; it travels only in the `x-api-key` header to `api.curseforge.com`; it never appears in a URL, a log line, a DTO or a cache key.
- Upstream hosts (HTTPS only, allowlisted before every request): API `api.modrinth.com`, `api.curseforge.com`; downloads `cdn.modrinth.com`, `edge.forgecdn.net`, `mediafilez.forgecdn.net`; images `cdn.modrinth.com`, `media.forgecdn.net`.
- Modrinth needs an identifying `User-Agent`: `mc-server-manager (self-hosted; +https://github.com/javilobo8/mc-server-manager)`. 300 req/min per IP: at most 8 requests in flight per host.
- CSP unchanged (`img-src 'self' data: blob:`, `connect-src 'self'`). The browser never loads a third-party URL: icons, gallery and description images go through `GET /api/content/image`. Descriptions are sanitised **in the API** (`marked` + `sanitize-html`); links get `target="_blank" rel="noopener noreferrer"`.
- Web rules: `apiPath` for every route with values; dialogs with `<form>` use `dialogSubmit`; the Configuration form keeps `useTabGuard` + `useBlocker`; status colours only through tones (`text-ok|warn|bad|info`, `StatusBadge`); headings with `SectionTitle`; no jsdom → logic in pure functions with tests, components checked with `renderToString`; ids with `crypto.getRandomValues` (no `randomUUID`); shadcn only with `pnpm dlx shadcn@3.8.5`.
- Agent: the pack cleanup is a write to `data`: per-server lock held, `fileWrites.enter`, deferred while `Held`. Docker on this machine: only `mcsm-test-*` resources (or `mcsm.test=true`), compare `docker ps -a`/`network ls`/`volume ls` before and after.
- Toolchain: `eval "$(mise env)"` at the repo root before `go`/`buf`.

## Review Focus

1. **A world silently broken by the pack lifecycle.** Uninstalling or switching a pack must delete only files listed in the outgoing pack's manifest, never anything under the level folder, `server.properties`, ops/whitelist/ban files or files that `MODRINTH_PROJECTS`/`CURSEFORGE_FILES` manage, and never follow a path out of `/data` (`../`, absolute, symlinked dir). → Task 4 `TestCleanKeepsWorldAndAdminFiles`, `TestCleanRejectsEscapingPaths`.
2. **"Back up first" applying a stale change.** The backup takes minutes; meanwhile the admin may save again, a migration may start, or the panel may restart. The chained apply must run only if the spec version is still the one the confirmation showed, never twice, and never after a restart. → Task 9 `fails when the spec changed while backing up`, `applies once even if the ok event repeats`, `a panel restart leaves the change unapplied`.
3. **Old specs gaining phantom changes.** Specs and templates stored before this plan lack `datapacks` and `plugins.curseforgeFiles`; opening and saving them must not produce a diff line, a new version or a new hash. → Task 2 (`curseforgeFiles` optional, no default), Task 3 hash tests, Task 10 `buildSpecPatch` test.
4. **Upstream answering 200 with junk, 429 or HTML.** Every adapter response is zod-checked before caching; a bad shape is a 502 with an English message (or stale data), never a 500 or a poisoned cache. → Task 5 `rejects a body with another shape and keeps the cached one`, Task 6/7 adapter tests.
5. **Hostile project content.** Modrinth Markdown and CurseForge HTML may carry `<script>`, `javascript:` links, `on*` attributes, iframes, SVG images or images from arbitrary hosts. → Task 6 sanitize tests, Task 8 image proxy tests (SVG refused, `content-security-policy: default-src 'none'; sandbox` on proxied bytes).
6. **Dependency resolution that loops or explodes** (cycles, a dependency with no compatible version, a dependency already in the pack or on the other platform). → Task 8 resolver tests (cycle, cap 200, unresolved message, `inPack`), Task 10 `crossPlatformWarnings`.

## Spike findings drive later tasks

Task 1 answers these questions against the real itzg image and records them in `docs/superpowers/notes/2026-10-30-itzg-content-spike.md`. Steps marked **[Fn]** below are applied as written when the finding is the *expected* answer, and replaced by the alternative in this table otherwise. If a finding contradicts this table in a way not listed here, stop and escalate to `architect` before Task 2.

| # | Question | Expected (plan as written) | If not |
|---|---|---|---|
| F1 | `CURSEFORGE_FILES` on `TYPE=PAPER` installs a Bukkit plugin (CF classId 5) into `/data/plugins`, both as `slug` and as `projectId:fileId`, and records it in `/data/.curseforge-files-manifest.json` | Add `plugins.curseforgeFiles` (Tasks 2, 3) and the CurseForge **Plugins** tab (Tasks 7, 11, 12) | Skip every **[F1]** step: no `plugins.curseforgeFiles`, `browserTabs` returns no CurseForge kinds for plugin types |
| F2 | Modrinth pack removed (`TYPE=MODRINTH` → `TYPE=FABRIC`): the files listed in `/data/.modrinth-modpack-manifest.json` stay on disk | Agent cleans on uninstall (Task 4) | `uninstallCleans["MODRINTH"] = false` in Task 4 |
| F3 | Same for `AUTO_CURSEFORGE` → `FORGE` with `/data/.curseforge-manifest.json`; and a cross-platform switch (Modrinth pack → CurseForge pack) leaves the Modrinth pack's files | Agent cleans on uninstall and on platform switch | Matching entry of `uninstallCleans` = `false`; cross-platform cleanup stays (each installer only knows its own manifest) |
| F4 | Same-platform switch (Modrinth pack A → pack B): itzg removes A's files itself | `sameSlugSwitchCleans["MODRINTH"] = false` (agent does nothing) | `= true`: agent also cleans when `slugOrUrl` changes on the same platform |
| F5 | Same for CurseForge pack A → B | `sameSlugSwitchCleans["AUTO_CURSEFORGE"] = false` | `= true` |
| F6 | Manifests are JSON with `files: string[]` relative to `/data`; the CF one also has `levelName`; names `.modrinth-modpack-manifest.json`, `.curseforge-manifest.json`, `.modrinth-manifest.json`, `.curseforge-files-manifest.json` | Constants in Task 4 as written | Use the observed names/fields in Task 4 constants and tests |
| F7 | `MODRINTH_PROJECTS=datapack:<project>:<versionId>` on `TYPE=PAPER` writes into `/data/$LEVEL/datapacks` and honours `LEVEL` | Agent emits `LEVEL=<level-name>` when `datapacks` is present (Task 3) | If `datapack:` + version fails: emit `datapack:<project>` only and drop pinning for datapacks (Tasks 3, 8); if `LEVEL` is ignored: drop the `LEVEL` step |
| F8 | On a mods server, removing the last `CURSEFORGE_FILES` entry (variable no longer emitted) deletes the files itzg installed | Nothing to do (today's behaviour is correct) | Record it; open an `architect` question (emitting `CURSEFORGE_FILES=` would change hashes). Not blocking |

## Execution order and batches

Branch `feat/content-browser` (the spec is already committed there). At most two agents at once. One `task-reviewer` per batch; `security-auditor` also on Batch B (Tasks 8–9: proxy, sanitiser, CF key) and on Task 4 (deletes files).

| Phase | Batch | Tasks | Implementer | Worktree | Files (disjoint) |
|---|---|---|---|---|---|
| 0 | S — spike | 1 | `infra-dev` | main tree | `docs/superpowers/notes/` |
| 1 | B (start) | 2 | `panel-api-dev` | main tree | `panel/packages/shared/**`, `proto/fixtures/spec-content-cases.json` |
| 2 | A — agent | 3, 4 | `systems-expert` | `.worktrees/content-go` | `agent/**`, `proto/mcsm/v1/agent.proto` (comment), `panel/packages/proto-ts/src/gen/**`, `panel/packages/shared/src/events.ts` |
| 2 | B — API | 5, 6, 7, 8, 9 | `panel-api-dev` | `.worktrees/content-api` | `panel/apps/api/**` |
| 3 | C — web | 10, 11, 12, 13, 14 | `web-ui-dev` | `.worktrees/content-web` | `panel/apps/web/**` |
| 4 | D — E2E + docs | 15 | `infra-dev` | main tree, after merging A, B, C | `panel/apps/e2e/**`, `website/src/content/docs/**` |

A and B run in parallel after Task 2. C starts when A finishes (two-agent cap); it depends only on the shared contract of Task 2 and the route table below, so it runs alongside the rest of B. Merge A, B, C into `feat/content-browser`, run the full verification, then Task 15.

### API route table (contract for Batches B and C)

All under the session guard; POSTs also under the foreign-`Origin` 403. `:platform` ∈ `modrinth|curseforge`.

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/content/:platform/search` | `contentSearchQuerySchema` | `ContentSearchDto` |
| `GET /api/content/:platform/categories?kind=` | | `{ categories: ContentCategoryDto[] }` |
| `GET /api/content/:platform/projects/:projectId` | | `ContentProjectDto` |
| `GET /api/content/:platform/projects/:projectId/versions` | `contentVersionsQuerySchema` | `{ versions: ContentVersionDto[]; stale: boolean }` |
| `GET /api/content/:platform/packs/:projectId/:versionId` | | `PackInfoDto` |
| `POST /api/content/lookup` | `lookupRequestSchema` | `{ entries: ContentEntryMetaDto[] }` |
| `POST /api/content/resolve` | `resolveRequestSchema` | `ResolveResultDto` |
| `POST /api/content/updates` | `updatesRequestSchema` | `{ updates: UpdateDto[] }` |
| `GET /api/content/image?url=` | | image bytes |
| `PATCH /api/servers/:id` with `backupFirst: true` | `serverPatchSchema` | `202 BackupFirstAccepted` (`{ jobId }`), or the usual `200 ServerDto` when the patch changes no spec |

CurseForge routes without a saved key → `409 { error: "Save a CurseForge API key in Settings to browse CurseForge" }` without touching the network.

## File map

| File | Responsibility |
|---|---|
| `docs/superpowers/notes/2026-10-30-itzg-content-spike.md` (new) | F1–F8 with commands and evidence |
| `proto/fixtures/spec-content-cases.json` | new `datapacks` / `plugins.curseforgeFiles` cases |
| `panel/packages/shared/src/spec-content.ts` | `datapacksSchema`, `plugins.curseforgeFiles` [F1], `usesCurseForge` |
| `panel/packages/shared/src/content.ts` (new) | constants, entry parse/format, target helpers, `pickLatest`, DTOs, request schemas |
| `panel/packages/shared/src/spec.ts` | `serverPatchSchema.backupFirst`, `BackupFirstAccepted` |
| `agent/internal/spec/content.go`, `limits.go` | `Datapacks`, `PluginSources.CurseforgeFiles` [F1], env emission, caps |
| `agent/internal/spec/packswitch.go` (new) | `ModpackOf`, `PackCleanupPlatform` |
| `agent/internal/packclean/packclean.go` (new) | delete an outgoing pack's files from its manifest, confined to `/data` |
| `agent/internal/store/packcleanup.go` (new) | `pack_cleanup` bucket |
| `agent/internal/reconcile/packclean.go` (new), `reconciler.go` | mark on Apply/StoreForce, clean before Create |
| `panel/apps/api/src/content/http.ts` (new) | `UpstreamClient`: cache, dedupe, stale, caps, allowlist, per-host concurrency |
| `panel/apps/api/src/content/repo.ts` (new), `db/migrations.ts` | `content_meta` table (`090_content_meta`) |
| `panel/apps/api/src/content/adapter.ts` (new) | `ContentAdapter` interface |
| `panel/apps/api/src/content/modrinth.ts`, `curseforge.ts` (new) | platform adapters |
| `panel/apps/api/src/content/sanitize.ts`, `pack.ts` (new) | description → safe HTML; `.mrpack`/CF zip manifest parsing |
| `panel/apps/api/src/content/resolve.ts`, `catalog.ts`, `image.ts`, `routes.ts` (new) | resolver, `ContentCatalog` (`app.content`), image proxy, routes |
| `panel/apps/api/src/servers/backup-first.ts` (new), `service.ts`, `routes.ts` | chained backup → apply |
| `panel/apps/web/src/lib/content-*.ts` (new) | pure logic: lists, target, deps, compat, pack, browser state |
| `panel/apps/web/src/hooks/use-content.ts`, `use-world.ts` (new) | queries/mutations |
| `panel/apps/web/src/components/content/*.tsx` (new) | browser dialog, installed list, remove dialog, pack card, image, description |
| `panel/apps/web/src/components/spec-form/version-section.tsx` | `contentUi` prop, lists, datapacks, pack card |
| `panel/apps/web/src/components/server-config-form.tsx`, `lib/config-apply.ts` | compat findings, "Back up first", job follow |
| `panel/apps/web/src/routes/new-server.tsx`, `lib/wizard.ts` | "Start from a modpack" |
| `panel/apps/e2e/tests/50-content.spec.ts` (new), `tests/fixtures/content/*` | E2E with stubbed `/api/content/**` |
| `website/src/content/docs/servers.md` | user docs |

---

### Task 1: itzg spike (F1–F8)

**Agent:** `infra-dev` · **Batch:** S

**Files:**
- Create: `docs/superpowers/notes/2026-10-30-itzg-content-spike.md`

**Interfaces:**
- Produces: the answers F1–F8 (yes/no + evidence), the exact manifest names and JSON fields, and the project ids/versions used (later tasks may reuse them as realistic fixture values).

Everything runs on this machine's Docker with names `mcsm-test-spike-*`, label `mcsm.test=true`, data under `deploy/data/spike/` (gitignored; never `/tmp`). Containers need outbound internet only (nftables blocks container → host, which this does not use). `itzg/minecraft-server:java21` carries a built-in CurseForge key (Java ≥ 17 tags), so no user key is needed. `SETUP_ONLY=true` makes itzg exit after installing content, without starting the server.

- [ ] **Step 1: Snapshot Docker state**

```bash
cd /home/lobo/dev/mc-server-manager
mkdir -p deploy/data
docker ps -a --format '{{.Names}}' | sort > deploy/data/spike-before-ps.txt
docker network ls --format '{{.Name}}' | sort > deploy/data/spike-before-net.txt
docker volume ls --format '{{.Name}}' | sort > deploy/data/spike-before-vol.txt
```

- [ ] **Step 2: Run the cases**

Helper (shell function, not a committed file):

```bash
run() { # run <case> <env...>
  local d="$PWD/deploy/data/spike/$1"; shift; mkdir -p "$d"
  docker run --rm --name "mcsm-test-spike-$(basename "$d")" --label mcsm.test=true \
    -e EULA=TRUE -e SETUP_ONLY=true "$@" -v "$d:/data" itzg/minecraft-server:java21
}
```

Cases (record for each: the command, `ls -la` of `/data`, `/data/plugins` or `/data/mods`, and the manifest contents, trimmed to the relevant lines):

1. **F1, F8** — `run cfplugin -e TYPE=PAPER -e VERSION=1.21.1 -e CURSEFORGE_FILES=<slug>` with a Bukkit plugin on CurseForge that has a 1.21.1 file (e.g. WorldEdit, project 31043; record the slug/id used). Then the same with `CURSEFORGE_FILES=<projectId>:<fileId>`. Then run once more **without** `CURSEFORGE_FILES` (unset): is the jar removed (F8)?
2. **F2, F6** — `run mrpack -e TYPE=MODRINTH -e VERSION=1.21.1 -e MODRINTH_MODPACK=<small server pack>` (e.g. `adrenaserver`; record it). Save `.modrinth-modpack-manifest.json`. Then, same folder, `run mrpack -e TYPE=FABRIC -e VERSION=1.21.1`: do the manifest's files remain?
3. **F4** — new folder: install pack A as in 2, then `MODRINTH_MODPACK=<another small Fabric pack>`: are A's files gone?
4. **F3, F5, F6** — new folder: `run cfpack -e TYPE=AUTO_CURSEFORGE -e CF_SLUG=<small pack A>` (pick the smallest Forge/Fabric pack you find, ≤ 30 mods; record it), save `.curseforge-manifest.json` (fields: `files`, `levelName`, `modId`, `fileId`…). Then `CF_SLUG=<small pack B>` (F5). Then `TYPE=<pack loader>` with `VERSION=<pack MC version>` and no CF variables: do B's files remain (F3)?
5. **F3 cross-platform** — new folder: Modrinth pack as in 2, then `TYPE=AUTO_CURSEFORGE -e CF_SLUG=<pack>`: do the Modrinth pack's files remain?
6. **F7** — `run dp -e TYPE=PAPER -e VERSION=1.21.1 -e LEVEL=myworld -e MODRINTH_PROJECTS=datapack:terralith:<a 1.21.1 version id of terralith>` (Terralith project `8oi3bsk5`, version `urbokcOc` was 1.21.1-compatible on 2026-10-30): is the zip in `/data/myworld/datapacks/`?

- [ ] **Step 3: Clean up and compare**

```bash
docker run --rm -v "$PWD/deploy/data:/d" alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 rm -rf /d/spike
docker ps -a --format '{{.Names}}' | sort | diff deploy/data/spike-before-ps.txt -
docker network ls --format '{{.Name}}' | sort | diff deploy/data/spike-before-net.txt -
docker volume ls --format '{{.Name}}' | sort | diff deploy/data/spike-before-vol.txt -
rm -f deploy/data/spike-before-*.txt
```

Expected: the three `diff`s print nothing.

- [ ] **Step 4: Write the note**

`docs/superpowers/notes/2026-10-30-itzg-content-spike.md`: date, image digest (`docker image inspect itzg/minecraft-server:java21 --format '{{index .RepoDigests 0}}'`), one section per case with the command and the evidence, then a table `F1…F8 | answer | consequence for the plan` using the "Expected / If not" columns of this plan.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-10-30-itzg-content-spike.md
git commit -m "docs: itzg content spike (CurseForge plugins, pack cleanup, datapacks)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared contract — spec sections, content DTOs and request schemas

**Agent:** `panel-api-dev` · **Batch:** B (runs alone, before A and the rest of B)

**Files:**
- Modify: `panel/packages/shared/src/spec-content.ts`
- Modify: `panel/packages/shared/src/spec.ts` (`serverPatchSchema`)
- Create: `panel/packages/shared/src/content.ts`, `panel/packages/shared/src/content.test.ts`
- Modify: `panel/packages/shared/src/spec-content.test.ts`, `panel/packages/shared/src/index.ts`
- Modify: `proto/fixtures/spec-content-cases.json` (append cases)

**Interfaces:**
- Produces (from `@mcsm/shared`):
  - `datapacksSchema = z.object({ modrinthProjects: list(entry).default([]) })`; `contentFields.datapacks: datapacksSchema.optional()` (so it travels in templates and `null` deletes it in a PATCH).
  - **[F1]** `pluginsSchema.curseforgeFiles: list(entry).optional()` — optional with **no default** (old specs keep no key; no phantom diff).
  - `usesCurseForge(s)` also true when `s.plugins?.curseforgeFiles?.length > 0` **[F1]**.
  - `serverPatchSchema` gains `backupFirst: z.boolean().optional()`; `interface BackupFirstAccepted { jobId: string }`.
  - From `content.ts`:
    - `CONTENT_PLATFORMS = ["modrinth","curseforge"] as const`, `type ContentPlatform`; `CONTENT_KINDS = ["mod","plugin","datapack","modpack"] as const`, `type ContentKind`; `CONTENT_SORTS = ["relevance","downloads","newest","updated"] as const`, `type ContentSort`.
    - `CF_GAME_ID = 432`; `CF_CLASS_ID = { mod: 6, plugin: 5, modpack: 4471 } as const`; `CF_MOD_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const`.
    - `MODRINTH_ID_RE = /^[A-Za-z0-9]{8}$/`; `CF_ID_RE = /^[1-9][0-9]{0,11}$/`; `CONTENT_LOADERS = ["fabric","quilt","forge","neoforge","paper","purpur","folia","spigot","bukkit","datapack"] as const`.
    - `CONTENT_LISTS: Readonly<Record<ContentListKey, { platform: ContentPlatform; kind: ContentKind; section: "mods"|"plugins"|"datapacks"; field: string }>>` with keys `"mods.modrinthProjects" | "mods.curseforgeFiles" | "plugins.modrinthProjects" | "plugins.curseforgeFiles" [F1] | "datapacks.modrinthProjects"`; `listFor(platform, kind): ContentListKey | null`.
    - `interface ParsedEntry { raw: string; projectRef: string; versionRef: string | null; pinned: boolean }`; `parseContentEntry(platform, raw): ParsedEntry`; `formatContentEntry(platform, projectId, versionId): string` (`${projectId}:${versionId}`).
    - `interface ContentTarget { gameVersion: string; loaders: string[] }`; `modrinthLoadersFor(type: string, kind: ContentKind, packLoader?: string | null): string[]`; `curseforgeLoaderFor(loaders: readonly string[]): number | null`.
    - `pickLatest<V extends { type: "release"|"beta"|"alpha"; publishedAt: string }>(versions: readonly V[], currentType: V["type"] | null): V | null`.
    - DTOs: `ContentHit`, `ContentSearchDto`, `ContentCategoryDto`, `ContentProjectDto`, `ContentDependencyDto`, `ContentVersionDto`, `ContentEntryMetaDto`, `ResolvedEntry`, `ResolveResultDto`, `UpdateDto`, `PackInfoDto` (fields below).
    - `CONTENT_LIST_KEYS` (the keys of `CONTENT_LISTS` as a tuple, for `z.enum`).
    - Schemas: `contentSearchQuerySchema`, `contentVersionsQuerySchema`, `contentTargetSchema`, `lookupRequestSchema`, `resolveRequestSchema`, `updatesRequestSchema`; inferred types `ContentSearchQuery`, `ContentVersionsQuery`, `LookupRequest`, `ResolveRequest`, `UpdatesRequest` (`z.infer`, i.e. the parsed shape: `loaders` is a `string[]`).

DTO fields (exact names; every image URL is already a panel proxy path `/api/content/image?url=…` or `null`):

```ts
export interface ContentHit { platform: ContentPlatform; projectId: string; slug: string; name: string; author: string; summary: string; iconUrl: string | null; downloads: number; categories: string[] }
export interface ContentSearchDto { hits: ContentHit[]; total: number; offset: number; limit: number; stale: boolean }
export interface ContentCategoryDto { id: string; label: string }
export interface ContentProjectDto extends ContentHit { descriptionHtml: string; gallery: string[]; links: { label: string; url: string }[]; pageUrl: string; clientOnly: boolean; distributable: boolean }
export interface ContentDependencyDto { projectId: string | null; versionId: string | null; type: "required" | "optional" | "incompatible" | "embedded" }
export interface ContentVersionDto { platform: ContentPlatform; projectId: string; versionId: string; label: string; type: "release" | "beta" | "alpha"; publishedAt: string; gameVersions: string[]; loaders: string[]; dependencies: ContentDependencyDto[]; installable: boolean; reason: string | null }
export interface ContentEntryMetaDto { list: ContentListKey; raw: string; resolved: boolean; projectId: string | null; versionId: string | null; slug: string | null; name: string | null; author: string | null; iconUrl: string | null; versionLabel: string | null; versionType: "release" | "beta" | "alpha" | null; gameVersions: string[]; loaders: string[]; dependencies: ContentDependencyDto[] }
export interface ResolvedEntry { list: ContentListKey; projectId: string; versionId: string; entry: string; name: string; selected: boolean; requiredBy: string[] }
export interface ResolveResultDto { add: ResolvedEntry[]; optional: { projectId: string; name: string; requiredBy: string[] }[]; inPack: { projectId: string; name: string }[]; conflicts: string[]; unresolved: string[] }
export interface UpdateDto { entry: string; projectId: string | null; currentVersionId: string | null; compatible: boolean; latest: { versionId: string; label: string; type: "release" | "beta" | "alpha"; entry: string } | null }
export interface PackInfoDto { platform: ContentPlatform; projectId: string; slug: string; versionId: string; name: string; versionLabel: string; iconUrl: string | null; minecraftVersion: string | null; loader: "fabric" | "forge" | "neoforge" | "quilt" | null; loaderVersion: string | null; contents: { platform: ContentPlatform; projectId: string }[]; contentsKnown: boolean; reason: string | null }
```

Request schemas (all `z.object(...).strict()`; reuse `VERSION_QUERY_RE` from `versions.ts` for `gameVersion`):

```ts
contentTargetSchema    = { gameVersion: string matching VERSION_QUERY_RE, loaders: z.array(z.enum(CONTENT_LOADERS)).max(6) }
contentSearchQuerySchema = { kind: z.enum(CONTENT_KINDS), q: z.string().max(100).default(""), gameVersion: VERSION_QUERY_RE.optional(),
                             loaders: comma list of CONTENT_LOADERS (string → array, ≤ 6).default([]), category: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
                             sort: z.enum(CONTENT_SORTS).default("relevance"), offset: z.coerce.number().int().min(0).max(9_950).default(0) }
contentVersionsQuerySchema = { kind, gameVersion optional, loaders comma list default [] }
lookupRequestSchema    = { entries: z.array({ list: z.enum(CONTENT_LIST_KEYS), entry: ENTRY_RE string }).max(MAX_LIST_ITEMS) }
resolveRequestSchema   = { list, target: contentTargetSchema, selections: z.array({ projectId: id string, versionId: id string }).min(1).max(50),
                           present: z.array({ list, entry }).max(MAX_LIST_ITEMS), pack: { platform, projectId, versionId }.nullable() }
updatesRequestSchema   = { list, target: contentTargetSchema, entries: z.array(ENTRY_RE string).max(MAX_LIST_ITEMS) }
```

where "id string" is `^[A-Za-z0-9]{1,64}$` (Modrinth base62 ids and CurseForge digits both match; adapters re-check with their own regex).

Target helper values (decided here; the web and the API use them as-is):

```
modrinthLoadersFor(type, "datapack")          → ["datapack"]
modrinthLoadersFor(type, "modpack")           → []           (packs filter by game version only)
modrinthLoadersFor("FABRIC", "mod")           → ["fabric"]
modrinthLoadersFor("QUILT", "mod")            → ["quilt", "fabric"]
modrinthLoadersFor("FORGE", "mod")            → ["forge"]
modrinthLoadersFor("NEOFORGE", "mod")         → ["neoforge"]
modrinthLoadersFor("PAPER", "plugin")         → ["paper", "spigot", "bukkit"]
modrinthLoadersFor("PURPUR", "plugin")        → ["purpur", "paper", "spigot", "bukkit"]
modrinthLoadersFor("FOLIA", "plugin")         → ["folia"]
modrinthLoadersFor("SPIGOT", "plugin")        → ["spigot", "bukkit"]
modrinthLoadersFor("MODRINTH"|"AUTO_CURSEFORGE", "mod", packLoader) → modrinthLoadersFor(packLoader.toUpperCase(), "mod") or [] when packLoader is null
anything else                                  → []
curseforgeLoaderFor(loaders) → CF_MOD_LOADER of the first of loaders found in ["forge","fabric","quilt","neoforge"]; null otherwise
```

`parseContentEntry` rules: Modrinth `^[A-Za-z0-9]{8}:[A-Za-z0-9]{8}$` → pinned; CurseForge `^[1-9]\d{0,11}:[1-9]\d{0,11}$` → pinned; otherwise `projectRef` = text before the first `:` (with a leading `datapack:`/`fabric:`/`forge:`/`paper:` prefix stripped on Modrinth), `versionRef` = the rest or null, `pinned: false`; a trailing `?` on the project is stripped.

`pickLatest` rule (spec call #6): allowed types = `release` when `currentType` is `release` or null; `release|beta` for `beta`; all for `alpha`. Newest by `publishedAt`. When `currentType` is null and no release exists, fall back to beta, then alpha.

- [ ] **Step 1: Append fixture cases**

Append to `proto/fixtures/spec-content-cases.json` (same `{name, ok, merge}` shape):

```json
{ "name": "datapacks on Paper", "ok": true, "merge": { "datapacks": { "modrinthProjects": ["terralith", "8oi3bsk5:urbokcOc"] } } },
{ "name": "datapacks entry already prefixed", "ok": true, "merge": { "datapacks": { "modrinthProjects": ["datapack:terralith"] } } },
{ "name": "datapacks present and empty", "ok": true, "merge": { "datapacks": { "modrinthProjects": [] } } },
{ "name": "datapacks entry with a space", "ok": false, "merge": { "datapacks": { "modrinthProjects": ["terra lith"] } } },
{ "name": "datapacks entry with a comma", "ok": false, "merge": { "datapacks": { "modrinthProjects": ["a,b"] } } },
{ "name": "CurseForge plugins on Paper [F1]", "ok": true, "merge": { "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [], "curseforgeFiles": ["31043:5547789"] } } },
{ "name": "CurseForge plugin with a comma [F1]", "ok": false, "merge": { "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [], "curseforgeFiles": ["31043,1"] } } }
```

(Drop the two `[F1]` cases if F1 is "no", and remove the `[F1]` marker from the names otherwise.)

- [ ] **Step 2: Write the failing tests**

`panel/packages/shared/src/content.test.ts`:

```ts
describe("content entries", () => {
  it("parses pinned Modrinth and CurseForge entries", () => {
    expect(parseContentEntry("modrinth", "AANobbMI:Yp8wLY1P")).toEqual({ raw: "AANobbMI:Yp8wLY1P", projectRef: "AANobbMI", versionRef: "Yp8wLY1P", pinned: true });
    expect(parseContentEntry("curseforge", "238222:5846880")).toMatchObject({ projectRef: "238222", versionRef: "5846880", pinned: true });
  });
  it("keeps hand-typed entries raw", () => {
    expect(parseContentEntry("modrinth", "lithium:beta")).toMatchObject({ projectRef: "lithium", versionRef: "beta", pinned: false });
    expect(parseContentEntry("modrinth", "datapack:terralith")).toMatchObject({ projectRef: "terralith", versionRef: null, pinned: false });
    expect(parseContentEntry("modrinth", "pl3xmap?")).toMatchObject({ projectRef: "pl3xmap", pinned: false });
    expect(parseContentEntry("curseforge", "jei")).toMatchObject({ projectRef: "jei", versionRef: null, pinned: false });
  });
  it("formats an entry", () => expect(formatContentEntry("modrinth", "AANobbMI", "Yp8wLY1P")).toBe("AANobbMI:Yp8wLY1P"));
});
describe("targets", () => {
  it.each([
    ["QUILT", "mod", null, ["quilt", "fabric"]], ["PURPUR", "plugin", null, ["purpur", "paper", "spigot", "bukkit"]],
    ["VANILLA", "datapack", null, ["datapack"]], ["MODRINTH", "mod", "neoforge", ["neoforge"]], ["MODRINTH", "mod", null, []],
    ["PAPER", "modpack", null, []],
  ])("%s %s (pack %s) → %j", (type, kind, pack, want) => expect(modrinthLoadersFor(type, kind as ContentKind, pack)).toEqual(want));
  it("maps CurseForge loaders", () => {
    expect(curseforgeLoaderFor(["quilt", "fabric"])).toBe(5);
    expect(curseforgeLoaderFor(["paper"])).toBeNull();
  });
});
describe("pickLatest", () => {
  const v = (type: "release" | "beta" | "alpha", publishedAt: string) => ({ type, publishedAt });
  const list = [v("beta", "2026-10-03"), v("release", "2026-10-01"), v("alpha", "2026-10-04"), v("release", "2026-09-01")];
  it("release entries only move to releases", () => expect(pickLatest(list, "release")).toBe(list[1]));
  it("beta entries may move to a newer beta", () => expect(pickLatest(list, "beta")).toBe(list[0]));
  it("alpha entries take anything newer", () => expect(pickLatest(list, "alpha")).toBe(list[2]));
  it("new entries fall back to beta when there is no release", () => expect(pickLatest([v("beta", "2026-10-03"), v("alpha", "2026-10-09")], null)?.type).toBe("beta"));
});
describe("request schemas", () => {
  it("rejects a game version with path characters", () => expect(contentSearchQuerySchema.safeParse({ kind: "mod", gameVersion: "../x" }).success).toBe(false));
  it("splits the loaders list and rejects unknown loaders", () => {
    expect(contentSearchQuerySchema.parse({ kind: "mod", loaders: "fabric,quilt" }).loaders).toEqual(["fabric", "quilt"]);
    expect(contentSearchQuerySchema.safeParse({ kind: "mod", loaders: "liteloader" }).success).toBe(false);
  });
  it("caps the offset at 9950 (CurseForge index+pageSize ≤ 10000)", () => expect(contentSearchQuerySchema.safeParse({ kind: "mod", offset: "9951" }).success).toBe(false));
  it("limits resolve selections to 50", () => {
    const sel = Array.from({ length: 51 }, () => ({ projectId: "AANobbMI", versionId: "Yp8wLY1P" }));
    expect(resolveRequestSchema.safeParse({ list: "mods.modrinthProjects", target: { gameVersion: "1.21.1", loaders: ["fabric"] }, selections: sel, present: [], pack: null }).success).toBe(false);
  });
});
```

Add to `spec-content.test.ts`:

```ts
it("old specs keep no plugins.curseforgeFiles key [F1]", () => {
  const s = specInputSchema.parse({ ...base, plugins: { modrinthProjects: [], spigetResources: [], urls: [] } });
  expect(Object.hasOwn(s.plugins!, "curseforgeFiles")).toBe(false);
});
it("CurseForge plugins need the API key [F1]", () => expect(usesCurseForge({ plugins: { curseforgeFiles: ["1:2"] } } as never)).toBe(true));
it("datapacks: null deletes the section in a PATCH", () => expect(specPatchNullError({ datapacks: null })).toBeNull());
it("datapacks list is capped at 1000", () => {
  expect(specInputSchema.safeParse({ ...base, datapacks: { modrinthProjects: Array.from({ length: 1001 }, (_, i) => `p${i}`) } }).success).toBe(false);
});
it("serverPatchSchema accepts backupFirst", () => expect(serverPatchSchema.parse({ spec: {}, backupFirst: true }).backupFirst).toBe(true));
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @mcsm/shared test`
Expected: FAIL (missing module `./content.js`, new fixture cases failing, `datapacks` unknown).

- [ ] **Step 4: Implement** `content.ts` with the interfaces above; `datapacksSchema`, `contentFields.datapacks`, `pluginsSchema.curseforgeFiles` **[F1]**, `usesCurseForge`; `backupFirst` and `BackupFirstAccepted` in `spec.ts`; `export * from "./content.js"` in `index.ts`. `usesCurseForge`'s parameter type gains `plugins?: { curseforgeFiles?: string[] } | undefined`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @mcsm/shared test && pnpm typecheck`
Expected: PASS (the web and API typecheck too: nothing else consumes the new fields yet).

- [ ] **Step 6: Commit**

```bash
git add panel/packages/shared proto/fixtures/spec-content-cases.json
git commit -m "feat(shared): datapacks section and content browser contract

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Agent spec — `datapacks`, CurseForge plugins, env emission

**Agent:** `systems-expert` (Batch A) · **Worktree:** `.worktrees/content-go`

**Files:**
- Modify: `agent/internal/spec/content.go`, `agent/internal/spec/limits.go`
- Test: `agent/internal/spec/content_test.go`, `agent/internal/spec/limits_test.go`

**Interfaces:**
- Consumes: the fixture cases of Task 2 (already iterated by `TestContentCasesSharedWithZod`).
- Produces:
  - `type DatapackSources struct { ModrinthProjects []string \`json:"modrinthProjects"\` }`; `Spec.Datapacks *DatapackSources \`json:"datapacks,omitempty"\`` placed under a new `// ── plan-11 ──` anchor in the `Spec` struct (and the matching anchors in `Validate` and `envList`).
  - **[F1]** `PluginSources.CurseforgeFiles []string \`json:"curseforgeFiles,omitempty"\``.
  - `func datapackEntry(e string) string` — `"datapack:" + e` unless `e` already starts with `datapack:`.
  - `(Spec).UsesCurseForge()` also true with `Plugins.CurseforgeFiles` non-empty **[F1]**.

Emission rules (exact):

```
MODRINTH_PROJECTS: emitted when Mods != nil || Plugins != nil || Datapacks != nil
                   = joinList(mods.modrinthProjects, plugins.modrinthProjects, map(datapackEntry, datapacks.modrinthProjects))
CURSEFORGE_FILES:  when Mods != nil || Plugins != nil: setIf(joinList(mods.curseforgeFiles, plugins.curseforgeFiles [F1]))
                   (identical output to today for every existing spec)
LEVEL [F7]:        when Datapacks != nil and properties["level-name"] != "": LEVEL = properties["level-name"]
                   (free env still wins: it is applied after)
```

Validation: `datapacks.modrinthProjects` with `listEntryRe` (`"datapacks.modrinthProjects"` in the error) and `plugins.curseforgeFiles` **[F1]** likewise; both in `validateLimits`' list caps.

- [ ] **Step 1: Write the failing tests** (in `content_test.go`, reuse `loadFixture`, `buildEnv`, `hashOfSpec`)

```go
func TestDatapacksEnv(t *testing.T) {
	s := loadFixture(t)
	s.Datapacks = &DatapackSources{ModrinthProjects: []string{"8oi3bsk5:urbokcOc", "datapack:terralith"}}
	env := buildEnv(t, s)
	if got := env["MODRINTH_PROJECTS"]; got != "datapack:8oi3bsk5:urbokcOc,datapack:terralith" {
		t.Fatalf("MODRINTH_PROJECTS = %q", got)
	}
	s.Mods = &ModSources{ModrinthProjects: []string{"lithium"}}
	if got := buildEnv(t, s)["MODRINTH_PROJECTS"]; got != "datapack:8oi3bsk5:urbokcOc,datapack:terralith,lithium" {
		t.Fatalf("mixed MODRINTH_PROJECTS = %q", got)
	}
}

func TestDatapacksEmptySectionClearsInstalled(t *testing.T) {
	s := loadFixture(t)
	s.Datapacks = &DatapackSources{}
	if v, ok := buildEnv(t, s)["MODRINTH_PROJECTS"]; !ok || v != "" {
		t.Fatalf("MODRINTH_PROJECTS = %q (present=%v), want present and empty", v, ok)
	}
}

func TestDatapacksLevelFromProperty(t *testing.T) { // [F7]
	s := loadFixture(t)
	s.Properties = map[string]string{"level-name": "myworld"}
	if _, ok := buildEnv(t, s)["LEVEL"]; ok {
		t.Fatal("LEVEL must not be emitted without a datapacks section")
	}
	s.Datapacks = &DatapackSources{ModrinthProjects: []string{"terralith"}}
	if got := buildEnv(t, s)["LEVEL"]; got != "myworld" {
		t.Fatalf("LEVEL = %q", got)
	}
	s.Env = map[string]string{"LEVEL": "other"}
	if got := buildEnv(t, s)["LEVEL"]; got != "other" {
		t.Fatalf("free env must win: %q", got)
	}
}

func TestNewSectionsKeepGoldenHash(t *testing.T) {
	s := loadFixture(t)
	s.Plugins = &PluginSources{}           // [F1] CurseforgeFiles nil
	withPlugins := hashOfSpec(t, s)
	s.Plugins = &PluginSources{CurseforgeFiles: []string{}} // [F1] present but empty
	if hashOfSpec(t, s) != withPlugins {
		t.Fatal("an empty plugins.curseforgeFiles must not change the hash")
	}
	s = loadFixture(t)
	s.Datapacks = nil
	if h := hashOfSpec(t, s); h != "09ff6e5490b40677" {
		t.Fatalf("absent datapacks changed the golden hash: %s", h)
	}
}

func TestPluginCurseForgeFilesEnv(t *testing.T) { // [F1]
	s := loadFixture(t)
	s.Type = "PAPER"
	s.Plugins = &PluginSources{CurseforgeFiles: []string{"31043:5547789"}}
	s.CurseForgeAPIKey = "k"
	env := buildEnv(t, s)
	if env["CURSEFORGE_FILES"] != "31043:5547789" || env["CF_API_KEY"] != "k" {
		t.Fatalf("CURSEFORGE_FILES=%q CF_API_KEY=%q", env["CURSEFORGE_FILES"], env["CF_API_KEY"])
	}
}
```

In `limits_test.go`: `datapacks.modrinthProjects` with 1001 entries → error containing `the datapacks.modrinthProjects list has 1001 elements (max. 1000)`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && eval "$(mise env)" && go test ./internal/spec/`
Expected: FAIL to compile (`DatapackSources` undefined), then the fixture cases fail.

- [ ] **Step 3: Implement** the struct fields, validation, caps and `contentEnv` rules above. Keep `TestHashGolden`, `TestContentHash` and `TestEmptyModsSectionClearsModrinthProjects` unmodified.

- [ ] **Step 4: Run to verify they pass**

Run: `cd agent && go vet ./... && go test ./internal/spec/`
Expected: PASS, including `TestHashGolden` and `TestContentCasesSharedWithZod`.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/spec
git commit -m "feat(agent): datapacks section and CurseForge plugins in the spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Agent — delete the outgoing modpack's files before the new container

**Agent:** `systems-expert` (Batch A) · **Review:** `task-reviewer` + `security-auditor`

**Files:**
- Create: `agent/internal/spec/packswitch.go`, `agent/internal/spec/packswitch_test.go`
- Create: `agent/internal/packclean/packclean.go`, `agent/internal/packclean/packclean_test.go`
- Create: `agent/internal/store/packcleanup.go`, `agent/internal/store/packcleanup_test.go`
- Modify: `agent/internal/store/store.go` (`DeleteSpec`), `agent/internal/store/tombstones.go` (`ForgetWithTombstone`)
- Create: `agent/internal/reconcile/packclean.go`, `agent/internal/reconcile/packclean_test.go`
- Modify: `agent/internal/reconcile/reconciler.go` (`Apply`, `StoreForce`, `reconcileLocked`)
- Modify: `agent/internal/app/app.go` (wire the write guard)
- Modify: `proto/mcsm/v1/agent.proto` (comment of `message Event`: two kinds), regenerate `agent/gen` and `panel/packages/proto-ts/src/gen` with `pnpm gen`
- Modify: `panel/packages/shared/src/events.ts` (`EVENT_KIND_LABEL`)

**Interfaces:**
- Consumes: `spec.Modpack`, `spec.PlatformModrinth`, `spec.PlatformAutoCurseForge` (Task 3's package), `fileWrites.enter` (`agent/internal/app/filewrites.go`).
- Produces:
  - `spec.ModpackOf(specJSON []byte) *Modpack` — lenient: unmarshals only `{"modpack": …}`; nil on error or absence (never validates).
  - `spec.PackCleanupPlatform(old, new *Modpack) string` — the outgoing platform whose files the agent must delete, or `""`.
  - `packclean.ManifestFor(platform string) string`, `packclean.Clean(dataDir, platform string, opt packclean.Options) (packclean.Result, error)`, `type Options struct { LevelNames []string }`, `type Result struct { Removed int; Kept int }`.
  - `(*store.Store).PutSpecMarkingPackCleanup(sp *mcsmv1.ServerSpec, platform string) error`, `PackCleanups(id string) ([]string, error)`, `ClearPackCleanup(id string) error`.
  - `(*reconcile.Reconciler).SetDataWriteGuard(fn func(serverID string) (leave func()))`.
  - `reconcile.KindPackCleanup = "pack_cleanup"`, `reconcile.KindPackCleanupSkipped = "pack_cleanup_skipped"`.

Rules:

```go
// [F2]–[F5] set these two tables from the spike note; the values below are the expected ones.
var uninstallCleans = map[string]bool{PlatformModrinth: true, PlatformAutoCurseForge: true}
var sameSlugSwitchCleans = map[string]bool{PlatformModrinth: false, PlatformAutoCurseForge: false}

// PackCleanupPlatform(old, new):
//   old == nil or old.Platform not in {MODRINTH, AUTO_CURSEFORGE}             → ""
//   new == nil                                         → old.Platform if uninstallCleans[old.Platform]
//   new.Platform != old.Platform                       → old.Platform          (each itzg installer only knows its own manifest)
//   new.SlugOrURL != old.SlugOrURL && sameSlugSwitchCleans[old.Platform] → old.Platform
//   otherwise                                          → ""   (version change of the same pack: itzg cleans)
```

`packclean.Clean` (constants per [F6]: `.modrinth-modpack-manifest.json` for MODRINTH, `.curseforge-manifest.json` for AUTO_CURSEFORGE; `.modrinth-manifest.json` and `.curseforge-files-manifest.json` are the admin-managed manifests):
1. Open `dataDir` with `os.OpenRoot`. A missing pack manifest → `Result{}`, nil. Manifest > 8 MiB or > 50 000 entries → error `"the previous modpack's manifest is too large"`.
2. Protected set: every `files` entry of the two admin-managed manifests; top-level names `server.properties`, `ops.json`, `whitelist.json`, `banned-players.json`, `banned-ips.json`, `usercache.json`, `eula.txt`; any path whose first element is one of `opt.LevelNames`, the CF manifest's `levelName`, `world`, or `<name>_nether` / `<name>_the_end` of each of them.
3. For each manifest entry: reject (count in `Kept`, log at warn) unless `filepath.IsLocal(p)` and it contains no NUL; skip protected; `root.Lstat` → remove only regular files and symlinks with `root.Remove` (never `RemoveAll`, never a directory); not-exist is fine. `os.Root` refuses any escape through symlinked directories.
4. Prune parent directories left empty (`root.Remove` on each parent up to, not including, the root; ignore "directory not empty").
5. Remove the pack manifest itself.

Reconciler:
- `Apply` and `StoreForce`: after the version guard, compute `platform := spec.PackCleanupPlatform(spec.ModpackOf(stored.SpecJson), spec.ModpackOf(sp.SpecJson))` (nil-safe when `stored == nil`) and call `st.PutSpecMarkingPackCleanup(sp, platform)` instead of `PutSpec` (one bbolt transaction; `platform == ""` behaves exactly as `PutSpec`). The bucket `pack_cleanup` holds a JSON set of platforms per server id; created on first use like `crash_latch`.
- `reconcileLocked`: when `existing == nil` after the recreate/replace step and before `os.MkdirAll`/`Create` (both branches, including the on-demand one), call `r.cleanPack(ctx, serverID, parsed, build.DataDir)`; an error is returned like any other (backoff, `Observed.error`), so the container is not created over a half-cleaned folder.
- `cleanPack`: platforms = `PackCleanups(id)` minus the current spec's `Modpack.Platform`; none → `ClearPackCleanup`. `parsed.DataPath != ""` (the agent does not mount that folder) → event `pack_cleanup_skipped` "The previous modpack's files were not removed: the data folder is outside DATA_ROOT. Remove them from the host if the server fails to start" and clear. Otherwise `leave := r.dataWrite(serverID)` (no-op when unset), `packclean.Clean` per platform with `LevelNames` = `[parsed.Properties["level-name"]]` when set, then event `pack_cleanup` "Removed N files installed by the previous modpack (Modrinth|CurseForge)", then clear.
- `DeleteSpec` and `ForgetWithTombstone` also delete the server's `pack_cleanup` key.
- `app.go`: `a.rec.SetDataWriteGuard(a.fileWrites.enter)` next to the other `Set*` calls.

- [ ] **Step 1: Write the failing tests**

`packswitch_test.go` — table `TestPackCleanupPlatform`:

```go
mr := func(slug string) *Modpack { return &Modpack{Platform: PlatformModrinth, SlugOrURL: slug} }
cf := func(slug string) *Modpack { return &Modpack{Platform: PlatformAutoCurseForge, SlugOrURL: slug} }
ftb := &Modpack{Platform: PlatformFTBA, SlugOrURL: "126"}
cases := []struct{ name string; old, new *Modpack; want string }{
	{"no pack before", nil, mr("a"), ""},
	{"uninstall Modrinth", mr("a"), nil, PlatformModrinth},
	{"uninstall CurseForge", cf("a"), nil, PlatformAutoCurseForge},
	{"Modrinth → CurseForge", mr("a"), cf("b"), PlatformModrinth},
	{"CurseForge → Modrinth", cf("a"), mr("b"), PlatformAutoCurseForge},
	{"version change", &Modpack{Platform: PlatformModrinth, SlugOrURL: "a", VersionID: "x"}, &Modpack{Platform: PlatformModrinth, SlugOrURL: "a", VersionID: "y"}, ""},
	{"same-platform switch [F4]", mr("a"), mr("b"), ""},
	{"FTB is not handled", ftb, nil, ""},
}
```

Plus `TestModpackOfIsLenient`: invalid JSON → nil; `{"modpack":{"platform":"MODRINTH","slugOrUrl":"a"}}` with an otherwise invalid spec → non-nil.

`packclean_test.go` (build the tree in `t.TempDir()`):
- `TestCleanRemovesManifestFiles`: manifest lists `mods/a.jar`, `config/a.toml`, `kubejs/x.js` → all removed, empty `mods`/`config`/`kubejs` dirs pruned, manifest removed, `Result{Removed: 3}`.
- `TestCleanKeepsWorldAndAdminFiles`: manifest also lists `world/datapacks/p.zip`, `myworld/region/r.0.0.mca`, `server.properties`, `ops.json`, `mods/extra.jar` (and `.modrinth-manifest.json` lists `mods/extra.jar`) with `Options{LevelNames: ["myworld"]}` → all of them still exist; `Kept: 5`.
- `TestCleanRejectsEscapingPaths`: entries `../outside.txt`, `/etc/hostname`, `link/evil.txt` where `link` is a symlink to a folder outside `dataDir` → the outside files still exist, no error.
- `TestCleanMissingManifestIsNoop`, `TestCleanNeverRemovesDirectories` (entry `mods` that is a non-empty dir → kept).
- `TestCleanCurseForgeLevelName`: CF manifest with `"levelName": "packworld"` and entry `packworld/level.dat` → kept.

`packcleanup_test.go` (store): put with platform → `PackCleanups` = `["MODRINTH"]`; a second put with `AUTO_CURSEFORGE` → both, sorted; put with `""` keeps the set; `ClearPackCleanup` empties; `ForgetWithTombstone` and `DeleteSpec` remove it.

`reconcile/packclean_test.go` (use `setup(t)` and `put` from `reconciler_test.go`; the data dir is `<dataRoot>/<slug>/data`):
- `TestUninstallPackCleansBeforeCreate`: running container from a `MODRINTH` spec; write `.modrinth-modpack-manifest.json` + `mods/a.jar` + `world/level.dat`; set `fake.CreateErr`; `rec.Apply` a `FABRIC` spec v2 → returns the create error; `mods/a.jar` gone, `world/level.dat` present, the old container removed (`calls(fake, "remove")` ≥ 1), marker cleared. Clear `CreateErr`, `rec.Reconcile` → container created.
- `TestPackCleanupDeferredWhileHeld`: `rec.Hold` → `Apply` uninstall → files still there and marker present; `release(ctx)` → files gone.
- `TestPackCleanupMarkerSurvivesRestart`: `Apply` while held, drop the reconciler, build a new one over the same store and release-free `Reconcile` → files gone.
- `TestSwitchBackToSamePlatformSkipsCleanup`: marker `MODRINTH`, current spec is a Modrinth pack → no deletion, marker cleared.
- `TestPackCleanupDataPathSkipped`: spec with `dataPath` → event `pack_cleanup_skipped` recorded (recorder from `setup`), marker cleared, nothing deleted.
- `TestPackCleanupUsesWriteGuard`: guard counts enter/leave → 1 and 1.

- [ ] **Step 2: Run to verify they fail**

Run: `cd agent && go test ./internal/spec/ ./internal/packclean/ ./internal/store/ ./internal/reconcile/`
Expected: FAIL to compile (new symbols undefined).

- [ ] **Step 3: Implement** in the order spec → packclean → store → reconcile → app wiring.

- [ ] **Step 4: Event kinds**

In `agent.proto`, add to the `kind:` list in the comment of `message Event`:

```
//   pack_cleanup          the agent deleted the files of a modpack that was uninstalled or replaced
//   pack_cleanup_skipped  those files could not be deleted (data folder outside DATA_ROOT)
```

In `events.ts`: `pack_cleanup: "Modpack files removed"`, `pack_cleanup_skipped: "Modpack files not removed"`. Run `pnpm gen`.

- [ ] **Step 5: Run to verify they pass**

Run: `eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=main" && (cd agent && go vet ./... && go vet -tags integration ./... && go test -race ./...) && pnpm --filter @mcsm/shared test`
Expected: PASS; `git status` shows only the comment change in the generated files.

- [ ] **Step 6: Commit**

```bash
git add agent proto panel/packages/proto-ts/src/gen panel/packages/shared/src/events.ts
git commit -m "feat(agent): remove the previous modpack's files on uninstall or platform switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API — upstream client and metadata cache table

**Agent:** `panel-api-dev` (Batch B) · **Worktree:** `.worktrees/content-api`

**Files:**
- Create: `panel/apps/api/src/content/http.ts`, `panel/apps/api/src/content/http.test.ts`
- Create: `panel/apps/api/src/content/repo.ts`, `panel/apps/api/src/content/repo.test.ts`
- Modify: `panel/apps/api/src/db/migrations.ts` (append `090_content_meta`)

**Interfaces:**
- Consumes: `UpstreamError` (`versions/sources.ts`), `Timers`/`realTimers` (`files/stream.ts`), `ManualTimers` (tests).
- Produces:
  - `type ContentFetch = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "manual" }) => Promise<Response>`
  - `const CONTENT_USER_AGENT = "mc-server-manager (self-hosted; +https://github.com/javilobo8/mc-server-manager)"`
  - `API_HOSTS`, `DOWNLOAD_HOSTS`, `IMAGE_HOSTS: ReadonlySet<string>` (values in Global Constraints)
  - `JSON_MAX_BYTES = 8 * 1024 * 1024`, `API_TIMEOUT_MS = 10_000`, `MAX_CACHE_ENTRIES = 1024`, `MAX_PER_HOST = 8`
  - `class UpstreamClient { constructor(opts: { fetch?: ContentFetch; now?: () => number; timers?: Timers; onError?: (url: string, err: unknown) => void }); json<T>(req: { url: string; method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; ttlMs: number; cacheKey?: string }, schema: z.ZodType<T>): Promise<{ data: T; stale: boolean }>; bytes(url: string, opts: { hosts: ReadonlySet<string>; maxBytes: number; timeoutMs: number; maxRedirects: number }): Promise<{ data: Buffer; contentType: string }> }`
  - `class ContentMetaRepo { constructor(db: Db); get(platform: ContentPlatform, kind: MetaKind, id: string): { data: unknown; fetchedAt: string } | null; getMany(platform, kind, ids: string[]): Map<string, { data: unknown; fetchedAt: string }>; put(platform, kind, id, data: unknown): void; purgeOlderThan(iso: string): number }`, `type MetaKind = "project" | "version" | "pack" | "ref"`

Behaviour of `json` (mirrors `VersionCatalog`, which is not refactored in this plan): only `API_HOSTS` over HTTPS (else `UpstreamError(null, "origin not allowed")` without fetching); cache key = `cacheKey ?? url` (POSTs must pass one); in-memory LRU of `MAX_CACHE_ENTRIES`; concurrent identical keys share one download; failures serve the stored entry with `stale: true`, else throw; zod check **before** storing; redirects refused; body capped at `JSON_MAX_BYTES`; deadline `API_TIMEOUT_MS` via `timers`; at most `MAX_PER_HOST` requests in flight per host (a FIFO queue, no timers); headers always include `user-agent` and `accept: application/json`, plus `content-type: application/json` on POST. `bytes` checks `opts.hosts` on the URL and on every redirect `location` (absolute or relative), follows at most `maxRedirects`, caps at `maxBytes` (both `content-length` and streamed), never caches.

Migration (append to the array; same style as `080_events`):

```sql
CREATE TABLE content_meta (
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (platform, kind, id)
);
```

- [ ] **Step 1: Write the failing tests** (`http.test.ts`, with a queued fake fetch like `versions/catalog.test.ts`)

- `caches a GET for its ttl and refetches after it` (ttl 60 000 ms; one call, then two after `advance(60_001)`).
- `POST is cached by cacheKey, never by url`.
- `shares one download between concurrent callers`.
- `serves the stored copy with stale: true when the source fails` (second fetch rejects → `{ stale: true }`, `onError` called with the URL).
- `rejects a body with another shape and keeps the cached one` (200 with `{"oops":1}` after expiry → stale copy, cache unchanged).
- `refuses hosts outside the allowlist without fetching` (`https://evil.example/x` and `http://api.modrinth.com/v2/x` → `UpstreamError`, zero calls).
- `refuses redirects on JSON` (302 → `UpstreamError` status 302).
- `caps the body at 8 MiB` (content-length 8 MiB + 1 → error; streamed overflow → error).
- `aborts after 10 s` (`ManualTimers.fire()` → `deadline exceeded`).
- `runs at most 8 requests per host at once` (9 pending fetches → 8 calls recorded; resolve one → 9).
- `bytes follows a redirect inside the allowlist and refuses one outside` (`edge.forgecdn.net` → 302 `https://mediafilez.forgecdn.net/…` ok; → `https://example.com/` error).

`repo.test.ts`: put/get round trip with JSON data; `getMany` returns only present ids; `put` replaces; `purgeOlderThan` deletes older rows and returns the count.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/api test -- src/content`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** `http.ts`, `repo.ts` and the migration.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/api test -- src/content src/db && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/content panel/apps/api/src/db/migrations.ts
git commit -m "feat(panel): upstream client and content metadata cache

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API — Modrinth adapter, description sanitiser, `.mrpack` reader

**Agent:** `panel-api-dev` (Batch B)

**Files:**
- Modify: `panel/apps/api/package.json` (`"marked": "18.1.1"`, `"sanitize-html": "2.18.1"`, `"fflate": "0.8.3"`; dev `"@types/sanitize-html": "2.16.2"`), `pnpm-lock.yaml`
- Create: `panel/apps/api/src/content/adapter.ts`
- Create: `panel/apps/api/src/content/sanitize.ts`, `sanitize.test.ts`
- Create: `panel/apps/api/src/content/pack.ts`, `pack.test.ts`
- Create: `panel/apps/api/src/content/modrinth.ts`, `modrinth.test.ts`
- Create: `panel/apps/api/src/content/fixtures/modrinth/*.json` (small hand-written responses)

**Interfaces:**
- Consumes: `UpstreamClient`, `ContentMetaRepo` (Task 5); shared DTOs/`pickLatest` (Task 2).
- Produces:
  - `adapter.ts`:
    ```ts
    export interface SearchInput { kind: ContentKind; q: string; gameVersion: string | null; loaders: string[]; category: string | null; sort: ContentSort; offset: number }
    export interface VersionFilter { kind: ContentKind; gameVersion: string | null; loaders: string[] }
    export interface ProjectMeta { projectId: string; slug: string; name: string; author: string; iconUrl: string | null; clientOnly: boolean; distributable: boolean }
    export interface ContentAdapter {
      readonly platform: ContentPlatform;
      search(q: SearchInput): Promise<ContentSearchDto>;
      categories(kind: ContentKind): Promise<ContentCategoryDto[]>;
      project(projectId: string): Promise<ContentProjectDto>;
      projects(ids: string[]): Promise<ProjectMeta[]>;
      versions(projectId: string, f: VersionFilter): Promise<{ versions: ContentVersionDto[]; stale: boolean }>;
      versionsByIds(ids: string[]): Promise<ContentVersionDto[]>;
      resolveRef(e: ParsedEntry, kind: ContentKind): Promise<{ projectId: string; versionId: string | null } | null>;
      pack(projectId: string, versionId: string): Promise<PackInfoDto>;
    }
    export const SEARCH_LIMIT = 20;
    export const PACK_MAX_BYTES = 64 * 1024 * 1024;
    export const PACK_TIMEOUT_MS = 60_000;
    export const VERSIONS_MAX = 200;
    export function proxiedImage(url: string | null | undefined): string | null; // "/api/content/image?url=" + encodeURIComponent(url) when the host is in IMAGE_HOSTS, else null
    ```
  - `sanitize.ts`: `descriptionHtml(source: { markdown: string } | { html: string }): string` (input capped at 512 KiB before parsing).
  - `pack.ts`: `readMrpackIndex(zip: Uint8Array): MrpackIndex` and `readCurseForgeManifest(zip: Uint8Array): CfPackManifest` (the latter used in Task 7), both zod-checked, both throw `UpstreamError(null, "the pack has no modrinth.index.json" | "the pack has no manifest.json")`; `interface MrpackIndex { versionId: string; name: string; dependencies: Record<string, string>; files: { path: string; sha1: string; server: "required"|"optional"|"unsupported"|null }[] }`; `interface CfPackManifest { minecraftVersion: string; loaderId: string | null; files: { projectId: number; fileId: number; required: boolean }[] }`; `loaderOf(deps: Record<string,string>): { loader: PackInfoDto["loader"]; version: string | null }` (`fabric-loader`→fabric, `quilt-loader`→quilt, `forge`, `neoforge`).
  - `modrinth.ts`: `class ModrinthAdapter implements ContentAdapter { constructor(http: UpstreamClient, repo: ContentMetaRepo) }`.

Modrinth facts this adapter relies on (verified 2026-10-30 against docs.modrinth.com and the live API):

| Need | Request | Notes |
|---|---|---|
| Search | `GET https://api.modrinth.com/v2/search?query=&facets=&index=&offset=&limit=20` | `facets` is a URL-encoded JSON array of arrays (OR inside, AND across). `index` ∈ `relevance|downloads|follows|newest|updated`. Hits: `project_id, slug, title, description, icon_url, author, downloads, categories, server_side, environment`; top level `total_hits, offset, limit`. Hit `project_type` is the project's *first* type (a datapack hit can say `mod`): never trust it, use the requested kind |
| Facets per kind | `[["project_type:<mod|plugin|datapack|modpack>"], [loaders as "categories:<l>"…] (omitted when empty), ["versions:<gameVersion>"] (omitted when null), ["server_side!=unsupported"], ["categories:<category>"] (when set)]` | also drop any hit with `server_side === "unsupported"` |
| Sort map | relevance→`relevance`, downloads→`downloads`, newest→`newest`, updated→`updated` | |
| Categories | `GET /v2/tag/category` | keep `header === "categories"` and `project_type === "modpack"` for packs, `"mod"` for mod/plugin/datapack; label = name with `-`→space, capitalised. Never forward the `icon` SVG |
| Project | `GET /v2/project/{id}` | `body` (Markdown), `gallery[].url`, `server_side`, `source_url`, `issues_url`, `wiki_url`, `discord_url`; `clientOnly = server_side === "unsupported"`; `pageUrl = https://modrinth.com/<kind>/<slug>` |
| Batch projects | `GET /v2/projects?ids=<JSON array>` | ≤ 100 ids per request; accepts slugs |
| Versions | `GET /v2/project/{id}/version?loaders=<JSON>&game_versions=<JSON>&include_changelog=false` | omit a filter when empty/null; map `version_number`→`label`, `version_type`→`type`, `date_published`→`publishedAt`; dependencies `{project_id, version_id, dependency_type}`; keep newest `VERSIONS_MAX` |
| Batch versions | `GET /v2/versions?ids=<JSON array>` | ≤ 100 per request |
| Version by number | `GET /v2/project/{id}/version/{id-or-number}` | for raw `slug:1.2.3` entries |
| Pack contents | primary file (`files[].primary`, else first) of the pack version from `cdn.modrinth.com`; `modrinth.index.json` inside; then `POST /v2/version_files` `{ "hashes": [sha1…], "algorithm": "sha1" }` → map hash → Version (`project_id`) | files with `env.server === "unsupported"` are skipped; `dependencies.minecraft` = game version |

Caching: search 5 min (`ttlMs: 300_000`), categories 24 h, project 1 h, versions 15 min (in memory); `ContentMetaRepo` stores `project` (ProjectMeta), `version` (ContentVersionDto) for every version seen, `ref` (slug → id) and `pack` (PackInfoDto, never expires). A pack over `PACK_MAX_BYTES` or unreadable → `contentsKnown: false`, `reason: "The pack is too large to inspect (over 64 MiB)"` / `"Could not read the pack's file list"`, with `minecraftVersion`/`loader` taken from the version's `game_versions`/`loaders` when they have exactly one value. Upstream status 429 → `HttpError(502, "Modrinth is rate limiting the panel: try again in a minute")`; other failures → `HttpError(502, "Could not query Modrinth")`.

Sanitiser policy (`sanitize-html`): allowed tags `p br hr h1 h2 h3 h4 h5 h6 strong b em i u s del code pre blockquote ul ol li a img table thead tbody tr th td details summary span div center`; attributes `a: [href]`, `img: [src, alt, width, height]`, `td/th: [colspan, rowspan]`; schemes `http`, `https` only; `transformTags.a` adds `target="_blank"` and `rel="noopener noreferrer"`; `img` whose `src` is in `IMAGE_HOSTS` → `src = proxiedImage(src)`, otherwise replaced by `<a href=src>alt or "image"</a>`; everything else (script, style, iframe, svg, form, on* attributes, `style`) dropped. Markdown goes through `marked.parse(markdown, { async: false, gfm: true })` first; its raw HTML is sanitised the same way.

- [ ] **Step 1: Install dependencies**

Run: `pnpm --filter @mcsm/api add marked@18.1.1 sanitize-html@2.18.1 fflate@0.8.3 && pnpm --filter @mcsm/api add -D @types/sanitize-html@2.16.2`
Expected: lockfile updated, no native build steps.

- [ ] **Step 2: Write the failing tests**

`sanitize.test.ts`:

```ts
it("drops scripts, event handlers and javascript: links", () => {
  const out = descriptionHtml({ html: `<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>` });
  expect(out).not.toMatch(/script|onclick|javascript:/i);
});
it("opens links in a new tab without opener", () => {
  expect(descriptionHtml({ markdown: "[docs](https://example.com)" })).toContain(`<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>`);
});
it("proxies CDN images and turns foreign images into links", () => {
  const out = descriptionHtml({ markdown: "![a](https://cdn.modrinth.com/data/x/a.png) ![b](https://i.imgur.com/b.png)" });
  expect(out).toContain(`src="/api/content/image?url=${encodeURIComponent("https://cdn.modrinth.com/data/x/a.png")}"`);
  expect(out).toContain(`<a href="https://i.imgur.com/b.png" target="_blank" rel="noopener noreferrer">b</a>`);
});
it("removes iframes, svg and inline styles", () => {
  expect(descriptionHtml({ html: `<iframe src="https://youtube.com"></iframe><svg onload="x"></svg><p style="color:red">t</p>` })).toBe("<p>t</p>");
});
it("caps the input at 512 KiB", () => expect(descriptionHtml({ markdown: "a".repeat(600 * 1024) }).length).toBeLessThanOrEqual(512 * 1024 + 16));
```

`pack.test.ts` (zips built in the test with `fflate.zipSync`): reads `modrinth.index.json` (minecraft 1.21.1, `fabric-loader` 0.16.9 → `loaderOf` = fabric/0.16.9; a file with `env.server: "unsupported"` kept with `server: "unsupported"`); missing index → `UpstreamError`; malformed JSON → `UpstreamError`; `readCurseForgeManifest` reads `minecraft.version`, the primary `modLoaders[].id` (`"forge-47.3.0"`), `files[].projectID/fileID/required`.

`modrinth.test.ts` (fake fetch returning fixtures; assert exact URLs):

```ts
it("searches mods with loader, version and server-side facets", async () => {
  await t.adapter.search({ kind: "mod", q: "sodium", gameVersion: "1.21.1", loaders: ["quilt", "fabric"], category: null, sort: "downloads", offset: 20 });
  const u = new URL(t.calls[0]!.url);
  expect(u.origin + u.pathname).toBe("https://api.modrinth.com/v2/search");
  expect(JSON.parse(u.searchParams.get("facets")!)).toEqual([["project_type:mod"], ["categories:quilt", "categories:fabric"], ["versions:1.21.1"], ["server_side!=unsupported"]]);
  expect(Object.fromEntries(u.searchParams)).toMatchObject({ query: "sodium", index: "downloads", offset: "20", limit: "20" });
  expect(t.calls[0]!.headers["user-agent"]).toBe(CONTENT_USER_AGENT);
});
it("hides client-only hits even if the facet is ignored", …);            // hit with server_side "unsupported" not returned
it("returns proxied icons", …);                                         // iconUrl starts with "/api/content/image?url="
it("datapack versions filter by the datapack loader", …);               // loaders=["datapack"] in the query (URL-decoded JSON)
it("maps versions newest first with dependencies", …);                  // label, type, publishedAt, dependencies[].type
it("batches versionsByIds in groups of 100", …);                        // 150 ids → 2 calls to /v2/versions?ids=
it("resolves a slug entry to the project id and caches the ref", …);    // GET /v2/project/sodium once; repo has kind "ref"
it("reads a pack's contents through the hash lookup", …);               // mrpack from cdn.modrinth.com + POST /v2/version_files {hashes, algorithm:"sha1"}
it("marks an oversized pack as contentsKnown: false", …);               // content-length 64 MiB + 1 → reason "The pack is too large to inspect (over 64 MiB)"
it("maps 429 to a rate-limit message", …);                              // HttpError 502 "Modrinth is rate limiting the panel: try again in a minute"
it("a 200 with another shape is a 502, not a 500", …);                  // HttpError 502 "Could not query Modrinth"
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @mcsm/api test -- src/content`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement** `adapter.ts`, `sanitize.ts`, `pack.ts`, `modrinth.ts` (zod schemas for each upstream document at the top of `modrinth.ts`; every id from upstream re-checked with `MODRINTH_ID_RE` before being used in a URL; path segments with `encodeURIComponent`).

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @mcsm/api test -- src/content && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add panel/apps/api pnpm-lock.yaml
git commit -m "feat(panel): Modrinth content adapter with sanitised descriptions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API — CurseForge adapter

**Agent:** `panel-api-dev` (Batch B)

**Files:**
- Create: `panel/apps/api/src/content/curseforge.ts`, `curseforge.test.ts`, `fixtures/curseforge/*.json`

**Interfaces:**
- Consumes: Task 5 client/repo, Task 6 `adapter.ts`, `descriptionHtml`, `readCurseForgeManifest`, `proxiedImage`.
- Produces: `class CurseForgeAdapter implements ContentAdapter { constructor(http: UpstreamClient, repo: ContentMetaRepo, key: () => string | null) }`; `NO_KEY_MESSAGE = "Save a CurseForge API key in Settings to browse CurseForge"`.

CurseForge Core API facts (verified 2026-10-30 against docs.curseforge.com/rest-api):

| Need | Request | Notes |
|---|---|---|
| Auth | header `x-api-key: <key>` | 401/403 → `HttpError(502, "CurseForge rejected the API key: check it in Settings")` |
| Search | `GET https://api.curseforge.com/v1/mods/search?gameId=432&classId=<6|5|4471>&searchFilter=&gameVersion=&modLoaderType=&categoryId=&sortField=&sortOrder=desc&index=&pageSize=20` | `modLoaderType` only for mods, from `curseforgeLoaderFor(loaders)`, and only with `gameVersion` (the API requires the pair). `index + pageSize ≤ 10000` (offset capped at 9950 by the schema). Response `data[]` + `pagination {index, pageSize, resultCount, totalCount}` |
| Sort map | relevance→`2` (Popularity), downloads→`6` (TotalDownloads), newest→`11` (ReleasedDate), updated→`3` (LastUpdated) | ModsSearchSortField 1=Featured 2=Popularity 3=LastUpdated 4=Name 5=Author 6=TotalDownloads 7=Category 8=GameVersion 9=EarlyAccess 10=FeaturedReleased 11=ReleasedDate 12=Rating |
| Categories | `GET /v1/categories?gameId=432&classId=<id>` | drop entries with `isClass: true`; `id` as string |
| Project | `GET /v1/mods/{modId}` + `GET /v1/mods/{modId}/description` (`data` is HTML) | `logo.thumbnailUrl`, `links.websiteUrl/wikiUrl/issuesUrl/sourceUrl`, `authors[0].name`, `downloadCount`, `allowModDistribution`, `screenshots[].url` (gallery). `clientOnly` always `false` (no reliable flag) |
| Batch projects | `POST /v1/mods` `{ "modIds": [...], "filterPcOnly": true }` | ≤ 100 per request |
| Files | `GET /v1/mods/{modId}/files?gameVersion=&modLoaderType=&index=0&pageSize=50` | newest 50 only; `releaseType` 1=release 2=beta 3=alpha; `gameVersions` mixes MC versions and loader names: split into `gameVersions` (matching `^\d+\.\d+(\.\d+)?(-.+)?$` or snapshots like `24w14a`) and `loaders` (lowercased `forge|fabric|quilt|neoforge`); `displayName`→`label`; `fileDate`→`publishedAt` |
| Dependencies | `dependencies[] { modId, relationType }` | relationType 3→`required`, 2→`optional`, 5→`incompatible`, 1→`embedded`; 4 (Tool) and 6 (Include) dropped; `versionId` always null |
| Batch files | `POST /v1/mods/files` `{ "fileIds": [...] }` | ≤ 100 per request |
| Not installable | `allowModDistribution === false` or `downloadUrl === null` | `installable: false`, `reason: "The author does not allow third-party downloads: the server cannot install it"` |
| Slug lookup | `GET /v1/mods/search?gameId=432&classId=<id>&slug=<slug>` | first exact `slug` match |
| Pack | `GET /v1/mods/{modId}/files/{fileId}` → `downloadUrl` (edge/mediafilez.forgecdn.net) → zip → `manifest.json` | `minecraftVersion` from `minecraft.version`; `loader`/`loaderVersion` from the primary `modLoaders[].id` split at the first `-`; contents = `files[].projectID`; `downloadUrl === null` → `contentsKnown: false` with the not-installable reason |

`slug` for packs stays the CurseForge slug: itzg's `CF_SLUG` takes a slug (`modpack.slugOrUrl`), so `PackInfoDto.slug` is what the web writes for CurseForge packs.

- [ ] **Step 1: Write the failing tests**

```ts
it("without a key it answers 409 and never fetches", async () => {
  const t = setup({ key: null });
  await expect(t.adapter.search(q({ kind: "mod" }))).rejects.toMatchObject({ statusCode: 409, message: NO_KEY_MESSAGE });
  expect(t.calls).toEqual([]);
});
it("searches with class, loader type and sort, key in the header only", async () => {
  await t.adapter.search({ kind: "mod", q: "jei", gameVersion: "1.21.1", loaders: ["neoforge"], category: null, sort: "newest", offset: 40 });
  expect(t.calls[0]!.url).toBe("https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&searchFilter=jei&gameVersion=1.21.1&modLoaderType=6&sortField=11&sortOrder=desc&index=40&pageSize=20");
  expect(t.calls[0]!.headers["x-api-key"]).toBe("cf-key");
  expect(t.calls.every((c) => !c.url.includes("cf-key"))).toBe(true);
});
it("plugins use class 5 and no modLoaderType [F1]", …);
it("modpacks use class 4471", …);
it("maps a rejected key to a 502 with a hint", …);                     // 403 → "CurseForge rejected the API key: check it in Settings"
it("splits gameVersions into versions and loaders", …);                // ["1.21.1","NeoForge","Server"] → gameVersions ["1.21.1"], loaders ["neoforge"]
it("maps relation types and drops tools and includes", …);
it("marks files without third-party distribution as not installable", …);
it("resolves a slug through search by slug and class", …);
it("reads a pack manifest from the file's download url", …);           // forge-47.3.0 → loader "forge", loaderVersion "47.3.0"
it("a pack without a download url has unknown contents", …);
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/api test -- src/content/curseforge`
Expected: FAIL.

- [ ] **Step 3: Implement** `curseforge.ts` (ids re-checked with `CF_ID_RE`; the key read at call time from `key()`; never logged — `onError` gets the URL only).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/api test -- src/content && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/content
git commit -m "feat(panel): CurseForge content adapter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API — resolver, catalog service, routes and image proxy

**Agent:** `panel-api-dev` (Batch B) · **Review:** `task-reviewer` + `security-auditor`

**Files:**
- Create: `panel/apps/api/src/content/resolve.ts`, `resolve.test.ts`
- Create: `panel/apps/api/src/content/catalog.ts`, `catalog.test.ts`
- Create: `panel/apps/api/src/content/image.ts`, `image.test.ts`
- Create: `panel/apps/api/src/content/routes.ts`, `routes.test.ts`
- Modify: `panel/apps/api/src/app.ts` (`AppOptions.content`, decoration, routes, purge on ready)

**Interfaces:**
- Consumes: Tasks 5–7; shared request schemas.
- Produces:
  - `resolve.ts`:
    ```ts
    export const MAX_RESOLVED = 200;
    export interface ResolveDeps {
      version(versionId: string): Promise<ContentVersionDto | null>;
      latest(projectId: string): Promise<ContentVersionDto | null>; // pickLatest(compatible versions, null)
      name(projectId: string): Promise<string>;                     // falls back to the id
    }
    export interface ResolveInput {
      list: ContentListKey;
      selections: { projectId: string; versionId: string }[];
      present: Map<string, { versionId: string | null; dependencies: ContentDependencyDto[] }>; // projectId → pinned version and its deps (same platform, all lists)
      inPack: Set<string>;
      target: ContentTarget;
    }
    export function resolveSelection(input: ResolveInput, deps: ResolveDeps): Promise<ResolveResultDto>;
    ```
  - `catalog.ts`: `class ContentCatalog { constructor(opts: { repo: ContentMetaRepo; curseforgeKey: () => string | null; fetch?: ContentFetch; now?: () => number; timers?: Timers; onError?: (url: string, err: unknown) => void }); adapter(p: ContentPlatform): ContentAdapter; lookup(items: LookupRequest["entries"]): Promise<ContentEntryMetaDto[]>; resolve(req: ResolveRequest): Promise<ResolveResultDto>; updates(req: UpdatesRequest): Promise<UpdateDto[]>; image(url: string): Promise<{ data: Buffer; contentType: string }>; purge(): number }`.
  - `image.ts`: `class ImageProxy { constructor(http: UpstreamClient, now: () => number); get(url: string): Promise<{ data: Buffer; contentType: string }> }`; `IMAGE_MAX_BYTES = 2 * 1024 * 1024`, `IMAGE_TTL_MS = 24 * 3_600_000`, `IMAGE_CACHE_BYTES = 32 * 1024 * 1024`, `IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]`.
  - `routes.ts`: `contentRoutes(app)` with the route table above; `declare module "fastify" { interface FastifyInstance { content: ContentCatalog } }`.

Resolver algorithm (breadth-first, deterministic order = selection order, then discovery order):

```
chosen = selections (selected: true); queue = their versions (deps.version(versionId); missing → unresolved "<id>: version <v> not found")
for each version in queue:
  for dep in version.dependencies:
    pid = dep.projectId ?? (await deps.version(dep.versionId))?.projectId   (both null → skip)
    required:
      if pid in present or chosen      → append requiredBy (name of the dependant) to that entry (present ones are not added)
      else if pid in inPack            → inPack += {pid, name}
      else: v = dep.versionId and deps.version(dep.versionId) compatible with target ? that : deps.latest(pid)
            v null → unresolved "<name(pid)> (required by <dependant>) has no version for <loaders.join("/")> <gameVersion>"
            else chosen += {pid, v, selected: false, requiredBy:[dependant]}; queue v
    optional: if pid not in present/chosen/inPack → optional += {pid, name, requiredBy}
    incompatible: if pid in present/chosen/inPack → conflicts += "<dependant> is incompatible with <name(pid)>"
    embedded: ignore
  chosen.size > MAX_RESOLVED → HttpError(400, "Too many dependencies to resolve (max. 200)")
also: for each present entry whose dependencies mark a chosen project incompatible → conflicts += "<present name> is incompatible with <chosen name>"
"compatible with target" = v.gameVersions includes target.gameVersion and (target.loaders empty or v.loaders ∩ target.loaders ≠ ∅)
add = chosen in order, each with entry = formatContentEntry(platform, pid, versionId) and list = input.list
```

Catalog behaviour:
- `lookup`: group by platform; pinned entries → `repo.getMany("version")` then `adapter.versionsByIds` for the missing ones; raw entries → `adapter.resolveRef` (cached as `ref`) then project meta; project meta from `repo.getMany("project")` then `adapter.projects`. Anything that fails or is unknown → `{ resolved: false, raw, list, …nulls, [] }` — never throws for a single entry; an upstream outage returns what the repo has.
- `resolve`: validates that `req.list`'s platform matches `pack`'s (when present) for `inPack`; `present` = lookup of `req.present` (versions' dependencies included); `inPack` = `pack(...)`.contents of the same platform (pack failure → empty set + nothing else).
- `updates`: for each entry: lookup meta; `compatible` = pinned version compatible with target; `latest` = `pickLatest(compatible versions of the project, current version type)`; `latest` null when it equals the current version.
- `purge()`: `repo.purgeOlderThan(now - 90 days)`; called from `app.addHook("onReady")`.

Routes validate params before any network: `:platform` ∈ `CONTENT_PLATFORMS` (else 404 "Not found"), Modrinth `projectId`/`versionId` `^[A-Za-z0-9]{8}$` or a slug `^[a-z0-9][a-z0-9_.-]{0,63}$` for `projectId`, CurseForge digits (`CF_ID_RE`) → else 400 "Invalid project id". Query/body through the shared schemas (`ZodError` → 400 by the global handler).

Image route: `GET /api/content/image?url=` → `url` must be `https:` with host in `IMAGE_HOSTS` (else 400 "Image host not allowed", no fetch); `ImageProxy.get` → bytes ≤ 2 MiB, `content-type` (without parameters) in `IMAGE_TYPES` (SVG refused: 502 "Unsupported image type"); response headers `content-type`, `cache-control: private, max-age=86400`, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`. LRU by total bytes (`IMAGE_CACHE_BYTES`), TTL 24 h, concurrent requests share one download.

`app.ts`: `AppOptions.content?: ContentCatalog`; under a new `// ── plan-11 ──` anchor after plan-10: `app.decorate("content", opts.content ?? new ContentCatalog({ repo: new ContentMetaRepo(opts.db), curseforgeKey: () => app.curseforge.get(), onError: (url, err) => app.log.warn({ url, err }, "could not query a content source") }))`, `await app.register(contentRoutes)`, `app.addHook("onReady", async () => { app.content.purge(); })`.

- [ ] **Step 1: Write the failing tests**

`resolve.test.ts` (fake `ResolveDeps` over an in-memory map; target `{ gameVersion: "1.21.1", loaders: ["fabric"] }`):

```ts
it("adds required dependencies once, with who requires them", async () => {
  // A@a1 requires B (no version) and C@c1; B@b2 requires D; present has D
  const r = await resolveSelection(input({ selections: [{ projectId: "A", versionId: "a1" }], present: [["D", "d1"]] }), deps);
  expect(r.add.map((e) => [e.projectId, e.versionId, e.selected, e.requiredBy])).toEqual([
    ["A", "a1", true, []], ["B", "b2", false, ["Alpha"]], ["C", "c1", false, ["Alpha"]],
  ]);
  expect(r.add.find((e) => e.projectId === "D")).toBeUndefined();
});
it("lists optional dependencies without adding them", …);
it("reports an incompatible project already installed", …);         // conflicts: ["Alpha is incompatible with Delta"]
it("reports an installed project that declares the new one incompatible", …);
it("does not add what the modpack already brings", …);              // inPack: [{projectId:"B", name:"Beta"}]
it("explains a dependency with no compatible version", …);          // unresolved: ["Beta (required by Alpha) has no version for fabric 1.21.1"]
it("replaces a pinned dependency version that does not fit the target", …);
it("terminates on dependency cycles", …);                            // A requires B, B requires A
it("caps the resolution at 200 projects", …);                        // HttpError 400 "Too many dependencies to resolve (max. 200)"
```

`catalog.test.ts`: `lookup` mixes a pinned entry served from the repo without network, a raw slug resolved once (second lookup: zero calls), and an unknown entry → `resolved: false` with `raw`; with fetch failing for everything, entries stored in the repo still come back resolved. `updates`: release entry with a newer beta and an older release → `latest` null; entry not compatible with a new target → `compatible: false` and `latest` = newest compatible release.

`image.test.ts` / route tests: allowlist (400, zero calls), SVG → 502, 2 MiB + 1 → 502, headers above, second request served from cache (one call), concurrent requests one call.

`routes.test.ts` (`buildApp({ db, content: new ContentCatalog({ repo, curseforgeKey: () => key, fetch: fake, timers: new ManualTimers() }) })`, session cookie as in `versions/routes.test.ts`):

```ts
it("requires a session", …);                                          // 401, zero calls
it("validates before touching the network", async () => {
  for (const url of ["/api/content/modrinth/projects/..%2F..%2Fetc/versions?kind=mod",
                     "/api/content/curseforge/projects/abc",
                     "/api/content/modrinth/search?kind=shader",
                     "/api/content/modrinth/search?kind=mod&gameVersion=1.21%0A"]) {
    expect([400, 404]).toContain((await get(url)).statusCode);
  }
  expect(calls).toEqual([]);
});
it("CurseForge without a key answers 409 with the Settings hint", …);
it("POST /api/content/resolve with a foreign Origin is 403", …);
it("lookup caps entries at 1000", …);                                  // 1001 → 400
it("never returns the CurseForge key", …);                             // key "cf-secret": no response body contains it
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/api test -- src/content`
Expected: FAIL.

- [ ] **Step 3: Implement** `resolve.ts`, `image.ts`, `catalog.ts`, `routes.ts`, app wiring.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck`
Expected: PASS (whole API suite: the app wiring must not break other tests).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/content panel/apps/api/src/app.ts
git commit -m "feat(panel): content catalog routes, dependency resolver and image proxy

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: API — "Back up first": apply a PATCH after a successful backup job

**Agent:** `panel-api-dev` (Batch B) · **Review:** `task-reviewer` + `security-auditor`

**Files:**
- Create: `panel/apps/api/src/servers/backup-first.ts`, `panel/apps/api/src/servers/backup-first.test.ts`
- Modify: `panel/apps/api/src/servers/service.ts` (extract `prepare`), `panel/apps/api/src/servers/routes.ts`

**Interfaces:**
- Consumes: `serverPatchSchema.backupFirst`, `BackupFirstAccepted` (Task 2); `app.backupsService.createNow(serverId)` (`backups/service.ts`); `app.jobs` (`JobService`); `app.events` `"job"` events (`(dto: JobDto, logChunk: string)`); `app.migrations.blockingServer(id)`.
- Produces:
  - `ServersService.prepare(id: string, input: { name?: string; spec?: SpecPatch }): { row: ServerRow; spec: Spec | null }` — everything `patch` does before writing (null check, dataPath check, merge, `completeSpec`, `checkPorts`, `checkHostname`); `patch` calls it.
  - `class BackupFirst { constructor(app: FastifyInstance); start(): void; request(id: string, input: { name?: string; spec?: SpecPatch }): Promise<BackupFirstAccepted | null> }` (null = no spec change: the route falls back to a normal `patch`), decorated as `app.backupFirst` inside `serverRoutes` (root, `fastify-plugin`), `start()` there too.
  - Job type `"spec_apply"`, payload `{ backupJobId, baseVersion, patch }`.

Flow of `request`:
1. `prepare` (errors are the usual 400/409, nothing created). `spec === null` → return null.
2. One pending chained apply per server: another one open → `HttpError(409, "A change is already waiting for a backup of this server")`.
3. `app.backupsService.createNow(id)` (node offline → its 409, nothing else created).
4. `jobs.create({ type: "spec_apply", serverId, nodeId, status: "running", message: "Waiting for the backup before applying the change", payload })`; remember `{ jobId, backupJobId, baseVersion: row.spec_version, input }`; if the backup job is already final (it can finish before this line), handle it now.
5. On the backup job's final event (once; later duplicates ignored): `failed`/`cancelled` → `finish(jobId, "failed", "The backup failed: the change was not applied")`; `ok` → if `app.migrations.blockingServer(id)` → failed "A migration started: the change was not applied"; if `servers.get(id)?.spec_version !== baseVersion` → failed "The configuration changed while the backup ran: the change was not applied. Review it and save again"; else `await serversService.patch(id, input)` → `finish(jobId, "ok", "Backup done; change applied (v<N>)")`, errors → failed with the `HttpError` message.
6. In-memory only: on a panel restart `JobService.interruptStale()` already fails `spec_apply` (not an agent job type), so the change is never applied late.

Route: `PATCH /api/servers/:id` parses `serverPatchSchema`; when `backupFirst` is true, `const accepted = await app.backupFirst.request(id, body)`; `accepted` → `reply.code(202).send(accepted)`; null → the normal `svc.patch` path.

- [ ] **Step 1: Write the failing tests** (`backup-first.test.ts`, with `FakeAgent` as in `backups/backups.test.ts`)

```ts
it("applies the change only after the backup succeeds", async () => {
  const res = await patch(s.id, { spec: { mods: null }, backupFirst: true });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json() as BackupFirstAccepted;
  const req = await agent.waitFor("backupNow");
  agent.ack(req.id);
  expect(server(s.id).specVersion).toBe(1);                               // not yet
  agent.send(progress(req, JobStatus.OK));
  await until(() => job(jobId).status === "ok");
  expect(server(s.id).specVersion).toBe(2);
  expect(server(s.id).spec.mods).toBeUndefined();
  expect(job(jobId).message).toBe("Backup done; change applied (v2)");
});
it("leaves the spec untouched when the backup fails", …);              // "The backup failed: the change was not applied"
it("fails when the spec changed while backing up", …);                  // normal PATCH in between → message above, version unchanged by the job
it("applies once even if the ok event repeats", …);                     // emit the backup job's ok twice → specVersion 2, not 3
it("rejects a second backup-first change while one is waiting", …);     // 409 "A change is already waiting for a backup of this server"
it("validates before backing up", …);                                   // invalid patch → 400 and no backupNow sent
it("needs the node online", …);                                         // agent disconnected → 409, no jobs created
it("without a spec change it behaves as a normal PATCH", …);            // { name: "x", backupFirst: true } → 200 ServerDto
it("a panel restart leaves the change unapplied", …);                   // interruptStale() → spec_apply failed; a later backup ok does nothing
it("a migration that starts meanwhile cancels the apply", …);
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/api test -- src/servers`
Expected: FAIL.

- [ ] **Step 3: Implement** `prepare` (pure refactor: the existing `patch.test.ts`/`servers.test.ts` keep passing), `backup-first.ts`, the route branch.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/api test && pnpm --filter @mcsm/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/api/src/servers
git commit -m "feat(panel): back up first, then apply a configuration change

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web — pure content logic

**Agent:** `web-ui-dev` (Batch C) · **Worktree:** `.worktrees/content-web`

**Files:**
- Create: `panel/apps/web/src/lib/content-lists.ts`, `content-target.ts`, `content-deps.ts`, `content-compat.ts`, `content-pack.ts` and a `*.test.ts` for each
- Modify: `panel/apps/web/src/lib/spec-edit.ts` (`FORM_KEYS`, `OPTIONAL_KEYS`), `panel/apps/web/src/lib/spec-diff.ts` (labels), `panel/apps/web/src/components/spec-form/spec-form.tsx` (`FIELD_TABS`)
- Test: `panel/apps/web/src/lib/spec-edit.test.ts`, `spec-diff.test.ts`

**Interfaces:**
- Consumes: shared contract (Task 2).
- Produces:
  - `content-lists.ts`: `listOf(spec: EditableSpec, key: ContentListKey): string[]`; `withList(spec, key, items: string[]): EditableSpec` (creates the section with its defaults — mods `{ modrinthProjects: [], curseforgeFiles: [], urls: [] }`, plugins `{ modrinthProjects: [], spigetResources: [], urls: [] }` without `curseforgeFiles` unless that is the key being set, datapacks `{ modrinthProjects: [] }`); `presentFor(spec, platform): { list: ContentListKey; entry: string }[]`; `removeEntries(spec, key, raws: string[]): EditableSpec`; `replaceEntry(spec, key, oldRaw, newRaw): EditableSpec`.
  - `content-target.ts`: `type BrowserTab = { platform: ContentPlatform; kind: ContentKind }`; `browserTabs(type: string, o: { curseforgePlugins: boolean }): BrowserTab[]`; `browseTarget(spec, kind: ContentKind, pack: PackInfoDto | null): { ok: true; target: ContentTarget } | { ok: false; reason: string; pinTo?: "release" }`; `FLOATING_REASON = "Browsing needs a concrete Minecraft version: LATEST and SNAPSHOT change by themselves, and pinned content would stop matching."`.
  - `content-deps.ts`: `dependentsOf(projectId: string, metas: readonly ContentEntryMetaDto[]): string[]` (names of present entries whose pinned version requires it); `unusedAfterRemoval(removed: readonly ContentEntryMetaDto[], remaining: readonly ContentEntryMetaDto[]): ContentEntryMetaDto[]`; `applyResolved(spec, result: ResolveResultDto): EditableSpec`; `addSummary(result): string`; `crossPlatformWarnings(selected: readonly { name: string; slug: string }[], others: readonly ContentEntryMetaDto[]): string[]`.
  - `content-compat.ts`: `type CompatFinding = { list: ContentListKey; entry: string; name: string; problem: "incompatible" | "floating" }`; `compatFindings(spec, metas, target: ContentTarget | null): CompatFinding[]`; `applyUpdates(spec, updates: readonly (UpdateDto & { list: ContentListKey })[]): { spec: EditableSpec; withoutVersion: string[] }`; `removedEntries(base, edited): { list: ContentListKey; entry: string }[]`; `backupOffer(o: { base: EditableSpec; edited: EditableSpec; packChange: PackChange; hasWorld: boolean | null }): boolean`.
  - `content-pack.ts`: `type PackChange = "none" | "install" | "upgrade" | "downgrade" | "switch" | "uninstall" | "unknown"`; `packChange(base: EditableSpec["modpack"], edited: EditableSpec["modpack"], versions: readonly ContentVersionDto[] | undefined): PackChange`; `withPackInstalled(spec, info: PackInfoDto): EditableSpec`; `withPackUninstalled(spec, info: PackInfoDto | null): { ok: true; spec: EditableSpec } | { ok: false; error: string }`; `packSlugOrUrl(info: PackInfoDto): string` (Modrinth → `projectId`, CurseForge → `slug`).

Values decided here:

```
browserTabs:
  VANILLA                        → modrinth: datapack, modpack · curseforge: modpack
  PAPER|PURPUR|FOLIA|SPIGOT      → modrinth: plugin, datapack · curseforge: plugin [F1, only when curseforgePlugins]
  FABRIC|FORGE|NEOFORGE|QUILT,
  MODRINTH|AUTO_CURSEFORGE       → modrinth: mod, datapack, modpack · curseforge: mod, modpack
  FTBA and anything else         → modrinth: datapack
browseTarget: kind "modpack" never needs a concrete version (gameVersion = spec.version when concrete, else "")
              floating (isFloatingVersion) for other kinds → { ok:false, reason: FLOATING_REASON, pinTo:"release" }
              MODRINTH/AUTO_CURSEFORGE mods with pack null or pack.loader null → { ok:false, reason: "Waiting for the modpack's details (loader and Minecraft version)" }
              pack types: gameVersion = pack.minecraftVersion
backupOffer: hasWorld !== false && (removedEntries(base, edited).length > 0 || packChange ∈ {"downgrade","switch","uninstall","unknown"})
packChange: none (same platform/slug/version), install (base undefined), uninstall (edited undefined), switch (platform or slugOrUrl differs),
            upgrade/downgrade by index in `versions` (newest first), unknown when either version is not in `versions`
withPackInstalled: type = platform type (MODRINTH | AUTO_CURSEFORGE), modpack = { platform, slugOrUrl: packSlugOrUrl(info), versionId: info.versionId,
                   loader: Modrinth ? (info.loader ?? "") : "" }, then withVersion(spec, info.minecraftVersion) when known, build ""
withPackUninstalled: info?.loader and info.minecraftVersion required, else { ok:false, error: "The modpack's loader is unknown: choose the server type by hand" };
                     type = loader.toUpperCase(), version = minecraftVersion, build = loaderVersion when BUILD_RE matches else "", modpack removed
addSummary: "Add 1 project" | "Add 2 projects + 3 dependencies" (selected vs not)
```

`FORM_KEYS` and `OPTIONAL_KEYS` gain `"datapacks"`. `spec-diff.ts`: `TOP_LABELS.datapacks = "Datapacks (section)"`, `NESTED_LABELS["datapacks.modrinthProjects"] = "Modrinth datapacks"`, `NESTED_LABELS["plugins.curseforgeFiles"] = "CurseForge plugins"` [F1], `"Datapacks (section)"` in `OPTIONAL_LABELS`, and `datapacks` handled like `mods`/`plugins` in the flattening. `FIELD_TABS`' version regex becomes `/^sf-(type|version|java|mp-|mods-|pl-|dp-|content-)/`.

- [ ] **Step 1: Write the failing tests** (examples; one `describe` per module)

```ts
it("withList creates plugins without a phantom curseforgeFiles key", () => {
  const s = withList(paper, "plugins.modrinthProjects", ["luckperms"]);
  expect(s.plugins).toEqual({ modrinthProjects: ["luckperms"], spigetResources: [], urls: [] });
});
it("an old spec without datapacks produces an empty PATCH", () => {
  const old = editableSpec(storedWithoutDatapacks) as EditableSpec;
  expect(buildSpecPatch(old, { ...old })).toEqual({});
});
it("Paper gets no CurseForge tab unless F1 allows it", () => {
  expect(browserTabs("PAPER", { curseforgePlugins: false })).toEqual([{ platform: "modrinth", kind: "plugin" }, { platform: "modrinth", kind: "datapack" }]);
});
it("a floating version blocks browsing mods but not modpacks", …);
it("a dependency is listed with the names of who requires it", …);
it("removing Sodium offers to remove Fabric API only when nothing else needs it", …);
it("applyResolved writes pinned entries to the right list without duplicates", …);
it("warns when a project looks installed from the other platform", …);   // "Fabric API is already installed from CurseForge"
it("compatFindings flags pinned entries without the new Minecraft version", …);
it("compatFindings flags pinned entries on a floating version", …);
it("applyUpdates replaces entries and names those without a compatible version", …);
it("backupOffer: removal with a world → true; removal with hasWorld false → false; unknown world → true", …);
it("packChange detects downgrade by position in the version list", …);
it("uninstalling a pack turns it into its loader with the pack's versions", () => {
  const r = withPackUninstalled(modrinthPackSpec, { ...info, loader: "fabric", minecraftVersion: "1.21.1", loaderVersion: "0.16.9" });
  expect(r).toMatchObject({ ok: true, spec: { type: "FABRIC", version: "1.21.1", build: "0.16.9" } });
  expect((r as { spec: EditableSpec }).spec.modpack).toBeUndefined();
});
it("uninstalling refuses without a known loader", …);
it("diff labels datapacks", () => expect(diffSpecs(base, { ...base, datapacks: { modrinthProjects: ["x"] } })).toContainEqual({ label: "Modrinth datapacks", before: "—", after: "x" }));
```

(`"—"` is `NONE` in `spec-diff.ts`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/web test -- src/lib`
Expected: FAIL.

- [ ] **Step 3: Implement** the modules and edits.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/lib panel/apps/web/src/components/spec-form/spec-form.tsx
git commit -m "feat(web): content lists, targets, dependencies and pack logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — browser dialog

**Agent:** `web-ui-dev` (Batch C)

**Files:**
- Create: `panel/apps/web/src/components/ui/checkbox.tsx` (`pnpm dlx shadcn@3.8.5 add checkbox`)
- Create: `panel/apps/web/src/hooks/use-content.ts`
- Create: `panel/apps/web/src/lib/content-browser.ts`, `content-browser.test.ts`
- Create: `panel/apps/web/src/components/content/browser-dialog.tsx`, `content-image.tsx`, `description.tsx`

**Interfaces:**
- Consumes: Task 10; route table; `CurseForgeKeyNotice` (`components/spec-form/curseforge-key.tsx`); `useVersions` (`hooks/use-versions.ts`).
- Produces:
  - `use-content.ts`: `useContentSearch(platform, query: ContentSearchQuery | null)`, `useContentCategories(platform, kind, enabled)`, `useContentProject(platform, projectId | null)`, `useContentVersions(platform, projectId | null, filter)`, `usePackInfo(modpack: { platform; projectId; versionId } | null)`, `useContentLookup(items: { list; entry }[])`, `resolveContent(req: ResolveRequest): Promise<ResolveResultDto>`, `checkUpdates(req: UpdatesRequest): Promise<UpdateDto[]>`, `useCurseForgeConfigured(): boolean | undefined` (reuses the `["settings","curseforge"]` query). Query keys `["content", …]`; `staleTime` 5 min; `retry: false`; every path with `apiPath`; list query parameters (`loaders`) are sent joined with `,` and built with `URLSearchParams`.
  - `content-browser.ts`: `interface BrowserState { tab: BrowserTab; q: string; category: string | null; sort: ContentSort; offset: number; detail: string | null; selected: Map<string, { projectId: string; versionId: string; name: string; slug: string; list: ContentListKey }>; anyVersion: boolean }`; `browserReducer(s: BrowserState, a: BrowserAction): BrowserState` (actions `tab`, `query`, `category`, `sort`, `page`, `open`, `toggle`, `version`, `anyVersion`, `clear`; changing tab/query/category/sort resets `offset` and `detail`; changing tab clears the selection); `searchQuery(s, target: ContentTarget | null): ContentSearchQuery | null`; `defaultVersionId(versions: readonly ContentVersionDto[], current: string | null): string | null` (installable only; `pickLatest(…, null)`).
  - `ContentBrowserDialog(props: { open: boolean; onOpenChange(o: boolean): void; spec: EditableSpec; pack: PackInfoDto | null; mode: "server" | "new-server"; initialTab?: BrowserTab; onApply(next: EditableSpec): void })`.
  - `ContentImage({ src, alt, size })` — renders `<img src={src}>` only for paths starting with `/api/content/image?`, else a neutral placeholder block.
  - `Description({ html })` — `dangerouslySetInnerHTML` of HTML already sanitised by the API (comment says so; the component never receives upstream HTML directly).

Dialog layout (layout "A"): near-full-screen (`sm:max-w-[min(96vw,1400px)] h-[90vh]`). Header: tabs per `browserTabs` grouped by platform (`TabsList variant="pill"`), search input (debounced 300 ms with a `setTimeout` in an effect — UI only, no test synchronises on it). Left column: category list (`useContentCategories`), sort `Select`, and for the Modpacks tab an "Any Minecraft version" checkbox (default off; on shows a `text-warn` note "Changing the Minecraft version of a world can break it"). Centre: result rows (icon, name, author, summary, downloads formatted with `Intl.NumberFormat`, `StatusBadge`-style "Installed" / "In modpack" badge from `presentFor` and `pack.contents`), a checkbox per row, "Load more" (`offset + SEARCH_LIMIT`, up to `total`). Right: detail pane (`useContentProject`): description, gallery thumbnails, version `Select` (`useContentVersions`, default `defaultVersionId`, non-installable versions disabled with their `reason`), dependencies of the chosen version (names via lookup), links (`target="_blank" rel="noopener noreferrer"`), "Client-only" `text-bad` notice when `clientOnly` (row checkbox disabled), CurseForge note "CurseForge does not say whether a mod runs on servers: client-only mods may stop the server from starting." Footer: selection count, conflicts/unresolved/warnings from the last resolve, primary button "Add to server" which first calls `resolveContent` and then shows `addSummary(result)` ("Add 2 projects + 3 dependencies") as a confirm step; conflicts block the confirm; confirm → `onApply(applyResolved(spec, result))` and close. Modpacks tab: a single selection; the confirm reads `usePackInfo` and calls `onApply(withPackInstalled(spec, info))` (pack switch/install; the Save confirmation handles backup). CurseForge tabs when `useCurseForgeConfigured() === false` → `CurseForgeKeyNotice` instead of results. Floating version → `FLOATING_REASON` plus a button "Pin Minecraft version to <newest stable VANILLA release>" → `onApply(withVersion(spec, release).spec)`. The `<form>` of the search box uses `dialogSubmit`.

- [ ] **Step 1: Add the checkbox primitive**

Run: `cd panel/apps/web && pnpm dlx shadcn@3.8.5 add checkbox`
Expected: `src/components/ui/checkbox.tsx` created; no other files changed (revert anything else).

- [ ] **Step 2: Write the failing tests** (`content-browser.test.ts`)

```ts
it("changing tab clears the selection and the page", …);
it("changing the query keeps the selection but resets offset and detail", …);
it("toggling twice unselects", …);
it("searchQuery is null while the target is not ready", () => expect(searchQuery(initial, null)).toBeNull());
it("searchQuery passes kind, loaders and version", () =>
  expect(searchQuery(initial, { gameVersion: "1.21.1", loaders: ["fabric"] })).toEqual({ kind: "mod", q: "", gameVersion: "1.21.1", loaders: ["fabric"], sort: "relevance", offset: 0 }));
it("modpacks with anyVersion search without a game version", …);
it("defaultVersionId skips non-installable versions and prefers releases", …);
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @mcsm/web test -- src/lib/content-browser`
Expected: FAIL.

- [ ] **Step 4: Implement** the hooks, reducer and components.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add panel/apps/web
git commit -m "feat(web): content browser dialog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — installed lists, removal, updates, datapacks in "Version and mods"

**Agent:** `web-ui-dev` (Batch C)

**Files:**
- Create: `panel/apps/web/src/lib/content-installed.ts`, `content-installed.test.ts`
- Create: `panel/apps/web/src/components/content/installed-list.tsx`, `remove-dialog.tsx`, `content-section.tsx`
- Modify: `panel/apps/web/src/components/spec-form/version-section.tsx`, `version-section.test.tsx`
- Modify: `panel/apps/web/src/components/server-config-form.tsx`, `panel/apps/web/src/routes/new-server.tsx` (pass `contentUi="browser"`)

**Interfaces:**
- Consumes: Tasks 10–11.
- Produces:
  - `content-installed.ts`: `interface InstalledRow { list: ContentListKey; raw: string; name: string; iconUrl: string | null; platform: ContentPlatform; versionLabel: string | null; pinned: boolean; dependencyOf: string[]; update: UpdateDto["latest"]; resolved: boolean }`; `installedRows(spec, metas: readonly ContentEntryMetaDto[], updates: readonly (UpdateDto & { list: ContentListKey })[]): InstalledRow[]` (sorted: selected projects first by name, dependencies after, raw entries last).
  - `VersionSection` gains `contentUi?: "text" | "browser"` (default `"text"`: the template editor and today's tests stay as they are — spec call #6).
  - `ContentSection({ spec, onChange, lists: ContentListKey[], title, kind, target, pack, onError })` — `SectionTitle`, "Browse" (opens `ContentBrowserDialog` on the matching tab), "Edit as text" toggle (shows the existing `ListField` textareas for the same lists plus URLs/Spiget; both views edit the same spec lists), the installed list, "Update all (N)".
  - `RemoveDialog({ open, row, unused: ContentEntryMetaDto[], onConfirm(alsoRemove: string[]) })` — checkbox list "Also remove unused dependencies", all checked by default; uses `dialogSubmit`.

Behaviour: with `contentUi="browser"`, the Mods/Plugins fieldsets become `ContentSection`s (mods: `mods.modrinthProjects`, `mods.curseforgeFiles`; plugins: `plugins.modrinthProjects`, `plugins.curseforgeFiles` [F1]); a new **Datapacks** `ContentSection` (`datapacks.modrinthProjects`; its text view is a `ListField` with id `sf-dp-modrinth`, label "Modrinth datapacks (MODRINTH_PROJECTS with datapack:)") appears on every type when the section exists or the type offers datapacks. Row: icon, name, source badge (Modrinth/CurseForge), version label, "pinned" or "latest" (raw entries: "as typed"), "Dependency of A, B" (`text-muted-foreground`), "Update to <label>" button when `update` is set, remove button. Removing opens `RemoveDialog` with `unusedAfterRemoval`. Update one / "Update all": `checkUpdates` → `resolveContent` for the updated versions → `applyUpdates` + `applyResolved`. The lookup uses every entry of the content lists; updates are checked once per open of the tab (query, not automatic polling). Unresolved rows show the raw text and a `text-warn` "Not found on <platform>: shown as typed".

- [ ] **Step 1: Write the failing tests**

`content-installed.test.ts`: rows ordered as specified; `dependencyOf` filled from metas; a raw entry row with `resolved: false`; update attached by `list` + `raw`.

`version-section.test.tsx` (new cases; existing ones untouched and still passing with the default `contentUi`):

```ts
const renderUi = (spec: EditableSpec, qc = new QueryClient()) =>
  renderToString(<QueryClientProvider client={qc}><VersionSection spec={spec} onChange={() => {}} contentUi="browser" /></QueryClientProvider>);
it("browser mode shows Browse and the installed list instead of textareas", () => {
  const html = renderUi({ ...defaultSpecInput(), type: "FABRIC", version: "1.21.1", mods: { modrinthProjects: ["AANobbMI:Yp8wLY1P"], curseforgeFiles: [], urls: [] } });
  expect(html).toContain("Browse");
  expect(html).toContain("Edit as text");
  expect(html).not.toContain("sf-mods-modrinth");
});
it("datapacks are offered on Paper", () => expect(renderUi({ ...defaultSpecInput(), type: "PAPER", version: "1.21.1" })).toContain("Datapacks"));
it("text mode keeps today's textareas and adds the datapacks one when the section exists", …);
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/web test -- src/lib/content-installed src/components/spec-form`
Expected: FAIL.

- [ ] **Step 3: Implement** the components and the `VersionSection` integration; pass `contentUi="browser"` from `ServerConfigForm` and from the wizard's from-scratch step.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web
git commit -m "feat(web): installed content lists with updates and removal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Web — modpack card and "Start from a modpack"

**Agent:** `web-ui-dev` (Batch C)

**Files:**
- Create: `panel/apps/web/src/components/content/pack-card.tsx`
- Modify: `panel/apps/web/src/components/spec-form/version-section.tsx`
- Modify: `panel/apps/web/src/lib/wizard.ts`, `wizard.test.ts`, `panel/apps/web/src/routes/new-server.tsx`
- Test: `panel/apps/web/src/components/spec-form/version-section.test.tsx`

**Interfaces:**
- Consumes: `usePackInfo`, `useContentVersions`, `withPackInstalled`, `withPackUninstalled`, `packChange`, `ContentBrowserDialog` (mode `"new-server"`).
- Produces:
  - `PackCard({ spec, onChange })` for `MODRINTH`/`AUTO_CURSEFORGE` in `contentUi="browser"`: icon, name, version label, "Minecraft <v> · <loader> <loaderVersion>", "Update available: <label>" (`pickLatest` over the pack's versions for the current version type), a version `Select` ("Change version"), "Switch modpack" (opens the browser on the Modpacks tab of the same platform first), "Uninstall" (`withPackUninstalled`; its error shown in `text-bad`), "Edit as text" (today's manual fields). FTB keeps the manual fields only.
  - `wizard.ts`: `SCRATCH = "scratch"` stays; new `MODPACK = "modpack"`; `creationSource("modpack", undefined, spec)` → `{ spec }`; `stepBlock(1, …)` with source `MODPACK` and `spec.modpack` undefined → `"Choose a modpack"`.
  - The wizard's step 1 adds an option "Start from a modpack" that opens `ContentBrowserDialog` (mode `"new-server"`: only Modpacks tabs, "Any Minecraft version" on by default, CurseForge tab follows the key notice); picking fills the spec with `withPackInstalled`; the summary (`summarizeSpec`) shows "Modpack: <name> <versionLabel>" from the modpack fields it already prints.

- [ ] **Step 1: Write the failing tests**

```ts
// wizard.test.ts
it("a modpack source needs a chosen pack", () => expect(stepBlock(1, { ...ctx, source: MODPACK, spec: defaultSpecInput() })).toBe("Choose a modpack"));
it("a modpack source creates from the edited spec", () => expect(creationSource(MODPACK, undefined, packSpec)).toEqual({ spec: packSpec }));
// version-section.test.tsx
it("browser mode shows the pack card for a Modrinth pack", …);   // contains "Change version", "Switch modpack", "Uninstall"
it("FTB keeps the manual fields", …);                             // contains "FTB modpack id"
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/web test -- src/lib/wizard src/components/spec-form`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web
git commit -m "feat(web): modpack card and new server from a modpack

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Web — Save confirmation: compatibility check and "Back up first"

**Agent:** `web-ui-dev` (Batch C)

**Files:**
- Create: `panel/apps/web/src/hooks/use-world.ts`
- Modify: `panel/apps/web/src/lib/config-apply.ts`, `config-apply.test.ts`
- Modify: `panel/apps/web/src/components/server-config-form.tsx`
- Modify: `panel/apps/web/src/lib/jobs.ts` (`JOB_TYPE_LABEL.spec_apply = "Apply after backup"`)

**Interfaces:**
- Consumes: `compatFindings`, `applyUpdates`, `backupOffer`, `packChange`, `removedEntries` (Task 10); `checkUpdates`, `useContentLookup`, `useContentVersions` (Task 11); `useJob` (`hooks/use-jobs.ts`); `BackupFirstAccepted` (Task 2).
- Produces:
  - `useWorldExists(serverId: string, levelName: string, enabled: boolean): boolean | null` — `GET apiPath\`/api/servers/${id}/files/stat?path=${levelName}\``: entry is a directory → true; 404 → false; anything else (offline, 5xx) → null (unknown, treated as "has a world").
  - `config-apply.ts`: `patchBody(p: PendingApply, backupFirst: boolean): { name?: string; spec?: SpecPatch; backupFirst?: true }`; `backupFirstOutcome(job: Pick<JobDto, "status" | "message"> | undefined): { state: "waiting" } | { state: "applied" } | { state: "failed"; message: string }`; `COMPAT_UNAVAILABLE = "The compatibility check could not run (content sources unreachable or no CurseForge key). You can still apply."`.

Behaviour in `ServerConfigForm`: when the confirmation opens, compute `findings = compatFindings(spec, metas, target)` (metas from `useContentLookup` over the edited lists; target from `browseTarget` for each kind); show them in a `text-warn` block with "Update to compatible versions" (→ `checkUpdates` with the new target, `applyUpdates`, close the dialog so the admin sees the updated form; entries without a version are listed as "No compatible version: <names>"). Lookup failed → `COMPAT_UNAVAILABLE`, Save stays enabled. When `backupOffer({ base, edited, packChange, hasWorld })` → a checked "Back up first" checkbox with "A backup job runs and the change is applied only if it succeeds". Apply → `api.patch(apiPath…, patchBody(pending, checked))`; a `202` keeps the dialog open showing `JobProgress` for `useJob(jobId)` (the panel's job, whose message says "Waiting for the backup…"), the Save button disabled; `backupFirstOutcome` `applied` → fetch the server, `resetTo(dto)`, `qc.setQueryData(["server", id], dto)`; `failed` → message in `text-bad`, edits kept, dialog closable. Closing the browser tab does not lose the change (the panel owns it); reopening shows the server as it is.

- [ ] **Step 1: Write the failing tests** (`config-apply.test.ts`)

```ts
it("adds backupFirst only when asked", () => {
  expect(patchBody(pending, false)).toEqual({ spec: pending.spec });
  expect(patchBody(pending, true)).toEqual({ spec: pending.spec, backupFirst: true });
});
it("follows the chained job", () => {
  expect(backupFirstOutcome(undefined)).toEqual({ state: "waiting" });
  expect(backupFirstOutcome({ status: "running", message: "Waiting for the backup before applying the change" })).toEqual({ state: "waiting" });
  expect(backupFirstOutcome({ status: "ok", message: "Backup done; change applied (v3)" })).toEqual({ state: "applied" });
  expect(backupFirstOutcome({ status: "failed", message: "The backup failed: the change was not applied" })).toEqual({ state: "failed", message: "The backup failed: the change was not applied" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @mcsm/web test -- src/lib/config-apply`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web
git commit -m "feat(web): compatibility check and back up first in the apply dialog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: E2E, visual check and docs

**Agent:** `infra-dev` (Batch D, after merging A, B and C)

**Decision:** the E2E does not reach Modrinth or CurseForge. Upstream data changes every day and the e2e nodes must not depend on the internet, so Playwright stubs the panel's own `/api/content/**` routes with `page.route` and recorded fixtures; everything else (PATCH, backup job, agent, itzg container creation) is real. The adapters are covered by Tasks 6–8 unit tests against fixtures; the real-upstream path is checked once by hand in Step 5.

**Files:**
- Create: `panel/apps/e2e/tests/50-content.spec.ts`
- Create: `panel/apps/e2e/tests/fixtures/content/{search-mods.json,project-sodium.json,versions-sodium.json,resolve-sodium.json,lookup.json,updates.json,pack-info.json,icon.png}`
- Modify: `website/src/content/docs/servers.md` (section "Version and mods": "Browsing Modrinth and CurseForge", "Installed content", "Modpacks", "Back up first"; mention that CurseForge needs the key in Settings and that FTB stays manual)

**Interfaces:**
- Consumes: the whole feature; helpers `nodeId`, `poll`, `shot`, `watchCsp` (`panel/apps/e2e/tests/helpers.ts`).

- [ ] **Step 1: Write the E2E** (`50-content.spec.ts`)

```ts
test("browse, add with dependencies, save; remove with back up first", async ({ page, request }) => {
  const csp = watchCsp(page);
  await page.route("**/api/content/**", (route) => fulfillFromFixture(route)); // URL → fixture; /api/content/image → icon.png
  const a = await nodeId(request, NODE_A);
  const s = await (await request.post("/api/servers", { data: { nodeId: a, name: "test-e2e-content", desiredState: "stopped",
    spec: { type: "FABRIC", version: "1.21.1", imageTag: "java21", memory: "2G" } } })).json();
  await request.post(`/api/servers/${s.id}/files/mkdir`, { data: { path: "world" } });  // "has a world"

  await page.goto(`/servers/${s.id}`); // then the Configuration tab
  // Version and mods → Browse → select Sodium → Add to server shows "Add 1 project + 1 dependency"
  // Installed list shows Sodium and "Fabric API — Dependency of Sodium"; shot "60-content-browser", "61-installed-list"
  // Review and apply → diff contains "Modrinth mods" → Apply → v2
  // Remove Sodium → dialog "Also remove unused dependencies" with Fabric API checked → Review and apply
  // "Back up first" is checked → Apply → job "Apply after backup" ends ok → spec has no mods entries; shot "62-back-up-first"
  expect(csp).toEqual([]);
});
```

Fixtures are realistic (Sodium `AANobbMI`, Fabric API `P7dR8mSH`, real-looking version ids) but small; `icon.png` ≤ 2 KiB.

- [ ] **Step 2: Run the E2E**

Run: `bash deploy/e2e/run.sh`
Expected: all specs pass (existing ones included); `panel/apps/e2e/screenshots/60-*.png`–`62-*.png` exist; compare `docker ps -a`/`network ls`/`volume ls` before and after: no difference.

- [ ] **Step 3: Look at the screenshots**

Read the three PNGs: tones (no raw palette colours), `SectionTitle` headings, the dialog fits at 1280×800 without horizontal scroll, icons visible (proxied), no layout overflow. Fix in the web (separate `fix(web): …` commit) if not.

- [ ] **Step 4: Docs**

Update `website/src/content/docs/servers.md` as listed; then `cd website && pnpm install && pnpm test && pnpm build`.
Expected: PASS (the content test checks links and anchors).

- [ ] **Step 5: Manual upstream check (no commit)**

With the local dev panel (`pnpm dev:api` + `pnpm dev:web`), browse Modrinth mods for Fabric 1.21.1, open a project with images in its description, add one mod with a dependency, and (if a key is saved locally) do the same on CurseForge. Note anything that differs from the fixtures in the PR description.

- [ ] **Step 6: Full verification and commit**

Run: `eval "$(mise env)" && pnpm lint:proto && buf breaking --against ".git#ref=main" && (cd agent && go vet ./... && go vet -tags integration ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build && pnpm gen && git diff --exit-code -- agent/gen panel/packages/proto-ts/src/gen`
Expected: all PASS; no diff after `pnpm gen`.

```bash
git add panel/apps/e2e website/src/content/docs/servers.md
git commit -m "test(e2e): content browser flow and docs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| Goal 1 browser dialog, layout A, multi-select, "N + M dependencies" | 11 |
| Goal 2 tabs per source and kind; kinds per type | 10 (`browserTabs`), 11 |
| Goal 3 automatic compatibility; Modrinth `server_side: unsupported` hidden; CF honest note | 6, 10, 11 |
| Goal 4 recursive dependencies, `incompatible` blocks, optional shown | 8, 11 |
| Goal 5 pinned `<projectId>:<versionId>` / `<projectId>:<fileId>` | 2, 8 |
| Goal 6 installed list + "Edit as text" | 12 |
| Goal 7 updates (one / all) | 8, 12 |
| Goal 8 + call 1 removal offers unused dependencies | 10, 12 |
| Goal 9 + call 3 compatibility warning in the Save confirmation | 10, 14 |
| Goal 10 pack lifecycle, world kept, agent cleanup, "Back up first" | 3, 4, 9, 10, 13, 14 |
| Goal 11 new server from a modpack | 13 |
| Goal 12 no CurseForge key notice | 7, 11 |
| Anti-goals: hash, CF key, silent breakage, client-only, unsanitised HTML | 3, 7–8, 4/9/14, 6, 6/8 |
| Constraint: image proxy, CSP, caps, stale cache | 5, 8 |
| Call 2 floating versions | 10, 11, 14 |
| Call 4 pack contents (64 MiB, hash lookup / manifest), cross-platform heuristic | 6, 7, 8, 10 |
| Call 5 CurseForge plugins spike | 1 (+ [F1] steps) |
| Call 6 newest release rule; "has a world"; template editor text-only | 2 (`pickLatest`), 14 (`useWorldExists`), 12 (`contentUi` default) |

## Calls made in this plan (review when reading)

1. **Agent cleanup lives in the reconciler, no protocol change.** `Apply`/`StoreForce` compare the stored and incoming `modpack` and persist a `pack_cleanup` marker in the same bbolt transaction; `reconcileLocked` deletes the files after removing the old container and before creating the new one. Survives agent restarts and holds; the panel needs nothing new.
2. **`plugins.curseforgeFiles` is optional without a default** (unlike the other lists) so old specs never show a phantom diff. Go uses `omitempty`; emission merges it into the same `CURSEFORGE_FILES` variable (itzg picks `bukkit-plugins` as the default category on plugin servers).
3. **`LEVEL` is emitted when `datapacks` is present and `level-name` is set**, because itzg installs datapacks into `${LEVEL:-world}/datapacks` while the panel sets the world name through `CUSTOM_SERVER_PROPERTIES`. Only specs with the new section change.
4. **Descriptions are sanitised in the API** (`marked` + `sanitize-html`), not in the browser: one sanitiser, tested in node without jsdom; the web renders the already-safe HTML. Images outside the two CDNs become links.
5. **Modpacks tab:** offered on Vanilla, mod-loader and modpack types (not on plugin types); filtered by the server's Minecraft version with an opt-in "Any Minecraft version" (warned), and never blocked by a floating version. The wizard starts with "Any Minecraft version" on.
6. **Dependencies of a fresh add** fall back to beta/alpha when no release exists (spec call #6's rule is for updates); `pickLatest(…, null)` encodes it.
7. **CurseForge packs keep the slug** in `modpack.slugOrUrl` (itzg's `CF_SLUG` takes a slug); mod/plugin entries use ids as the spec says.
8. **"Back up first" state is in memory**; a panel restart fails the `spec_apply` job (existing `interruptStale`), so a change is never applied late. A spec version check prevents applying over a newer save.
9. **FTB packs and imported servers with `dataPath`:** FTB stays manual and the agent does not clean FTB files; with `dataPath` the agent cannot see the folder, so it emits `pack_cleanup_skipped` instead of deleting.
10. **E2E stubs `/api/content/**` in the browser** (Playwright `page.route`) instead of a fake upstream server: no panel configuration knob to redirect upstream hosts is added.
