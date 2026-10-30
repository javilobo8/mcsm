# Content browser (mods, plugins, datapacks, modpacks) — design

Date: 2026-10-30. Amends the main spec (`2026-10-12-mc-server-manager-design.md`, §4.1 content sections), where mods,
plugins and modpacks are typed by hand as slugs.

## Intent

Today the administrator installs content by leaving the panel: open modrinth.com or curseforge.com, check by hand that
the project has a file for the server's loader and Minecraft version, copy the slug, paste it in a textarea, and
remember the dependencies (Fabric API, Architectury, …). The itzg image does **not** fill that gap: Modrinth
dependencies are off by default (`MODRINTH_DOWNLOAD_DEPENDENCIES=none`) and `CURSEFORGE_FILES` cannot resolve them at
all.

The administrator wants to browse Modrinth and CurseForge **from the server's own content section**, see only what is
compatible with that server, pick it, and have everything (dependencies included) added on its own — the way Prism
Launcher does it, but for a server. Modpacks get a full lifecycle: pick, install, change version, switch, uninstall,
keeping the world. It has to feel professional: rich lists with icons, exact versions, clear warnings, nothing that
silently breaks a world.

## Goals

1. **Browser dialog** (layout "A", chosen on the mockup): a large, near-full-screen dialog opened from a "Browse"
   button in each content section. Left: filters (categories, sort). Centre: results (icon, name, author, summary,
   downloads, "Installed" badge). Right: detail pane (description, version picker, dependencies, links to the project
   page). Several projects can be selected; one "Add to server" applies them all, showing "N + M dependencies to add".
2. **Tabs per source and kind**: Modrinth and CurseForge; kinds **Mods**, **Plugins**, **Datapacks** (Modrinth only),
   **Modpacks**. Which kinds are offered depends on the server type (mods for Fabric/Forge/NeoForge/Quilt and modpack
   types; plugins for Paper/Purpur/Folia/Spigot…; datapacks for every type).
3. **Compatibility is automatic**: results and versions are filtered by the server's loader and Minecraft version. On
   Modrinth, projects with `server_side: unsupported` (client-only: minimaps, shaders loaders…) are hidden. CurseForge
   has no reliable server-side flag: show everything compatible and do not pretend otherwise.
4. **Dependencies resolved by the panel**, recursively, for the chosen version: required dependencies are added as
   normal entries, pinned, and marked "dependency of X, Y". Already-present projects are not duplicated. Incompatible
   declarations (Modrinth `incompatible`) block the add with a clear message. Optional dependencies are shown, not
   added.
5. **Pinned versions, like Prism**: every entry added through the browser is pinned to an exact version
   (`<projectId>:<versionId>` on Modrinth, `<projectId>:<fileId>` on CurseForge), so a restart never upgrades a mod by
   itself.
6. **Installed list instead of textareas**: each content section shows its entries as a list (icon, name, source
   badge, version, "pinned/latest", "dependency of …", remove). "Edit as text" keeps today's textareas for power use;
   both views edit the same spec lists.
7. **Updates**: the list shows "Update available" per entry (newest compatible version) with update-one and
   "Update all".
8. **Removal**: removing an entry offers to remove the dependencies no remaining entry requires (see "Calls made by
   the designer", item 1).
9. **Version/loader changes**: when the server's Minecraft version or type changes, the panel checks the pinned
   entries and lists the ones without a compatible pinned version, offering "Update to compatible versions" (and
   flagging those with none). Version ids skip itzg's compatibility check, so this check is ours.
10. **Modpack lifecycle** (Modrinth and CurseForge):
    - **Install**: picking a pack and a version sets the server type (`MODRINTH`/`AUTO_CURSEFORGE`), the pinned
      `modpack` section and its loader, and shows the Minecraft version and loader the pack brings.
    - **Change version** (up or down) from the installed pack's card, with "Update available".
    - **Switch** to another pack, and **uninstall**: the server becomes a plain loader server (type, Minecraft version
      and, when known, loader `build` taken from the pack) so the world keeps loading.
    - In every case **the world is kept**. Files installed by the outgoing pack are removed, the new pack's files are
      installed; the world, `server.properties`, ops/whitelist and the administrator's own extra entries stay.
    - Before switching, downgrading or uninstalling a pack (and before any change that removes mods from a server that
      has a world), the confirmation offers **"Back up first"**, checked by default, which runs a normal backup job and
      applies the change only if it succeeds.
    - Extra mods on top of a pack: the browser filters them by the pack's loader and Minecraft version.
11. **New server from the browser**: the "New server" wizard offers "Start from a modpack", reusing the browser's
    Modpacks tab; picking one fills type, version, loader and pack.
12. **No CurseForge key**: the CurseForge tabs show a notice linking to Settings (the existing `CurseForgeKeyNotice`
    pattern) instead of results.

## Non-goals

- Hangar (PaperMC's plugin repository): the itzg image cannot install from it. Spiget stays as it is, in "Edit as
  text".
- FTB modpack browsing (stays a manual field).
- Resource packs, shaders, exporting a client modpack.
- Scheduled/automatic updates. Updates are always an explicit click.
- Managing `.jar` files uploaded by hand (that is the file manager's job).

## Anti-goals (a failure even if it "works")

- Any existing server changing container or `mcsm.spec_hash` because of this feature. Absent/unchanged sections emit
  exactly what they emit today; `TestHashGolden` stays untouched.
- The CurseForge API key reaching the browser. All CurseForge calls go through the panel.
- A world silently broken: removing content or changing a pack never happens without the confirmation (and backup
  offer) above.
- Client-only Modrinth content being installed from the browser.
- Loading third-party scripts or unsanitised HTML into the panel.

## Constraints

- Spec stays the **single source of truth** for what gets installed: the browser only writes the same string lists
  (`mods.modrinthProjects`, `mods.curseforgeFiles`, `plugins.modrinthProjects`, `modpack`) through
  `serversService.patch`, with the usual validation (Go and zod identical, caps unchanged).
- Itzg facts this relies on (verified 2026-10-30): `MODRINTH_PROJECTS` entries accept `project:versionId`, removing
  an entry deletes its file, and the prefix `datapack:` installs a Modrinth datapack; `CURSEFORGE_FILES` accepts
  `project:fileId` and cleans up removed entries; `AUTO_CURSEFORGE` and Modrinth modpacks clean up files from previous
  versions of the **same** pack via their manifests and never delete world data. Unverified, to check before relying
  on it: whether `CURSEFORGE_FILES` installs Bukkit plugins, and what itzg does with the previous pack's files when
  the pack is removed or the platform changes (most likely nothing).
- CurseForge files with `allowModDistribution: false` cannot be downloaded by itzg: show them as not installable, with
  the reason.
- Upstream APIs: Modrinth v2 (no key; identifying `User-Agent` required; 300 req/min) and CurseForge Core API
  (`x-api-key`; gameId 432; classIds: 6 mods, 5 Bukkit plugins, 4471 modpacks). Responses are bounded and cached like
  `VersionCatalog` (injectable `fetch`, tests never touch the network, stale on upstream failure, host allowlist).
- CSP stays strict (`img-src 'self' data: blob:`, no third-party scripts). Icons, gallery and description images are
  served through a panel image proxy restricted to the CDN hosts of both platforms, with a size cap and cache.
- Descriptions (Modrinth Markdown, CurseForge HTML) are rendered sanitised; links open in a new tab with
  `rel="noopener noreferrer"`.
- Web runs on plain HTTP on the LAN and the panel UI rules apply (tones, `PAGE`/`SectionTitle`, `dialogSubmit`,
  `useTabGuard`, pure functions with tests, no jsdom).
- Templates: the content sections already travel in templates; nothing new should break that.

## Decisions

### Spec

- `mods`, `plugins` and `modpack` keep their current shape. Browser-added entries use ids, not slugs, so they are
  stable across renames.
- **New optional section `datapacks: { modrinthProjects: string[] }`** (Go + zod + shared fixture), emitted into
  `MODRINTH_PROJECTS` with the `datapack:` prefix. Absent emits nothing (hash intact). Available on every type.
- Plugins from CurseForge need a list of their own (`plugins.curseforgeFiles`) only if the check above confirms itzg
  supports it; otherwise the CurseForge Plugins tab is dropped from this version.

### Panel API

- A content catalog service (`app.content`, sibling of `app.versions`) with platform adapters for Modrinth and
  CurseForge: search, project detail, versions/files for a loader + Minecraft version, dependency resolution, update
  check for a list of pinned entries, and modpack metadata (loader, Minecraft version, loader version).
- A global cache of project/version data (see "Calls made by the designer", item 1): no per-server provenance is
  stored; "dependency of" and unused dependencies are derived from the pinned versions' declared dependencies.
  Entries the cache cannot resolve are shown raw (as typed).
- Image proxy route for icons and description images (host allowlist, size cap, cache).
- The CurseForge key is read from `app.curseforge` server-side only.

### Agent

- Removing a modpack, or switching to a pack on a different platform, must delete the files the outgoing pack
  installed (from its manifest under `/data`) before the container starts with the new spec, keeping the world and
  config the admin owns. It counts as a write to `data` (the `fileWrites` counter and `Held` → `busy` rules) and runs
  under the per-server lock.

### Web

- `VersionSection`'s mods/plugins fieldsets become installed lists with "Browse" and "Edit as text"; the modpack
  fieldset becomes a pack card (icon, name, version, update, change version, switch, uninstall). FTB keeps the manual
  fields.
- The browser dialog is one component with the tabs above, used from the server's content section and from the
  "New server" wizard.

### Calls made by the designer after the builder check (the administrator delegated them; review when reading)

1. **Browser actions edit the unsaved form; Save applies.** "Add to server", remove, update, and every pack action
   change the Configuration form's state like any other field (dirty state, `useTabGuard`, one Save through
   `planApply` + confirmation + one PATCH). Nothing reaches the server until Save.
   - Consequence: **no per-server provenance is stored.** "Dependency of X" is derived at display time from the pinned
     versions' declared dependencies (an entry is shown as a dependency when another present entry requires it). The
     panel only keeps a global cache of project/version data (name, icon, author, version label, dependencies,
     loaders, game versions), keyed by platform + id, so it also works for entries edited as text, imported or coming
     from templates. This replaces the "per-server content metadata" of the API section.
   - Removal: removing an entry opens a small confirmation listing the dependencies that no remaining entry requires,
     checked by default ("Also remove unused dependencies: Fabric API").
   - **"Back up first"** lives in the existing Save confirmation: it appears (checked) when the change removes content
     entries, removes/switches the modpack, or moves the pack version down. With it checked, Save sends the PATCH with
     a `backupFirst` flag; the panel runs a normal backup job and applies the patch only if it succeeds (a server-side
     chained job, so closing the tab does not lose it). The response reports the job so the UI can follow it.
2. **Browsing needs a concrete Minecraft version.** With `LATEST`/`SNAPSHOT` the browser does not search; it explains
   why and offers "Pin Minecraft version to <current release>" (edits the form's version). Typing entries by hand in
   "Edit as text" stays allowed. The compatibility check (goal 9) also warns when pinned entries coexist with a
   floating version.
3. **The compatibility check (goal 9) is a warning in the web, not a server-side gate.** A pure function plus a lookup
   endpoint; its findings appear in the Save confirmation with "Update to compatible versions". Raw API PATCHes and
   templates are not checked (single administrator; the API stays offline-safe). If the lookup fails (upstream down, no
   CurseForge key), the confirmation says the check could not run, and Save is still allowed.
4. **"Already present" includes the pack's own contents, on the pack's platform.** For an installed or selected pack,
   the panel reads its file list (Modrinth: `modrinth.index.json` inside the `.mrpack`, files mapped to projects with
   Modrinth's hash lookup; CurseForge: `manifest.json` inside the pack zip, which carries project/file ids). Downloads
   are capped (64 MiB) and the result is cached per pack version. Those projects show "In modpack", are not added again
   as dependencies, and count for `incompatible` checks. **Across platforms**, matching is heuristic only (same slug or
   name): it shows a warning ("Fabric API is already installed from CurseForge"), never blocks.
5. **CurseForge plugins start with a spike.** The first task verifies whether `CURSEFORGE_FILES` installs Bukkit
   plugins into `/data/plugins`. If it does, add `plugins.curseforgeFiles` (Go + zod + fixture). If not, Paper-family
   servers get no CurseForge tab in this version (Modrinth plugins only; Spiget and URLs stay in "Edit as text"); no
   fallback is built. The same first task verifies what itzg does with the outgoing pack's files on uninstall,
   platform switch and same-platform switch, which decides how much the agent cleanup must do.
6. Builder-level calls: "newest" for updates = newest **release** version (beta/alpha only when the entry is already
   on one); "has a world" = the level folder exists on the node (unknown → treated as yes); the template editor does
   not get the browser in this version (only "Edit as text").

## Left to the builder

- Exact table/column names for content metadata, cache TTLs, page sizes, debounce timings.
- Which Markdown/HTML sanitiser to use (bundled, no CDN).
- Whether the modpack file cleanup happens in the agent's `Apply` from the stored previous spec, or as a new explicit
  operation (if it needs a protocol change, it goes through `architect`).
- How categories/sort options map per platform.
- How the plan is split into tasks and tracks.
