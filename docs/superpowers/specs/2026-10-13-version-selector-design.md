# Minecraft version and build/loader picker — design

Date: 2026-10-13. Extends the main spec (`2026-10-12-mc-server-manager-design.md`, §4.1 and §8).

## 1. Goal

When creating a server (and when editing its configuration or a template) the administrator picks
the Minecraft version from a list according to the type, and optionally the loader/build version
(Fabric loader, Forge, NeoForge, Paper build…). Today the version is free text and the build
can't be pinned except with variables in `env`.

Nothing is downloaded from the panel or the agent: `itzg/minecraft-server` downloads the jar at startup
from `TYPE`, `VERSION` and the build variable. The panel only offers lists of valid values,
obtained from the official sources.

Acceptance criteria:

- In the wizard, with type Paper, the picker lists Paper's stable versions (newest
  first); choosing `1.20.1` switches Java to `java17` with a notice and the build picker lists Paper's
  stable builds for 1.20.1. Creating the server starts a container with
  `VERSION=1.20.1` and `PAPER_BUILD=<chosen>`.
- Updating the agent does not recreate any existing container (`TestHashGolden` intact).
- With the sources unreachable, the picker shows the error and lets you type the version by hand; the
  server is created all the same.

## 2. Sources (public JSON, no key; checked on 2026-10-13)

| Type | Minecraft versions | Builds / loaders | itzg build variable |
|---|---|---|---|
| VANILLA | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` (`type` release/snapshot; old_alpha/old_beta are discarded) | — | — |
| PAPER | `https://fill.papermc.io/v3/projects/paper` (`versions` grouped by family) | `…/v3/projects/paper/versions/{v}/builds` (`id`, `channel`; only `STABLE`) | `PAPER_BUILD` |
| FOLIA | `https://fill.papermc.io/v3/projects/folia` | `…/v3/projects/folia/versions/{v}/builds` (only `STABLE`) | `FOLIABUILD` (no underscore; `scripts/start-deployFolia`) |
| PURPUR | `https://api.purpurmc.org/v2/purpur` (`versions`, ascending) | `https://api.purpurmc.org/v2/purpur/{v}` (`builds.all`, ascending) | `PURPUR_BUILD` |
| SPIGOT | `https://hub.spigotmc.org/versions/` (HTML index of `<version>.json`; only names `^\d+\.\d+(\.\d+)?$`) | — | — |
| FABRIC | `https://meta.fabricmc.net/v2/versions/game` (`version`, `stable`) | `https://meta.fabricmc.net/v2/versions/loader/{v}` (`loader.version`, `loader.stable`) | `FABRIC_LOADER_VERSION` |
| QUILT | `https://meta.quiltmc.org/v3/versions/game` (`version`, `stable`) | `https://meta.quiltmc.org/v3/versions/loader/{v}` (`loader.version`; unstable if it carries a `-…` suffix) | `QUILT_LOADER_VERSION` |
| FORGE | keys of `https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json` | `maven-metadata.json[v]` (`"<v>-<forge>"` → `<forge>`) + `…/forge/promotions_slim.json` (`<v>-recommended`) | `FORGE_VERSION` |
| NEOFORGE | derived from `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge` | the same list filtered by MC version (unstable if it carries a `-beta`/`-alpha` suffix) | `NEOFORGE_VERSION` |

Modpacks (`MODRINTH`, `AUTO_CURSEFORGE`, `FTBA`) and unknown types: no list (free text as today).

Deriving NeoForge's MC version (from the part before the first `-`):

- major ≥ 26: `A.B.C.N` → `A.B` if `C = 0`, otherwise `A.B.C` (`26.3.0.76` → `26.3`, `26.1.2.5` → `26.1.2`).
- major 20–25: `A.B.N` → `1.A` if `B = 0`, otherwise `1.A.B` (`21.0.x` → `1.21`, `21.1.x` → `1.21.1`).
- Any other form (`0.25w14craftmine.3-beta`) is discarded.

Stability: where the source doesn't state it (Paper, Folia, Purpur, Spigot, Forge, versions
derived from NeoForge), a version is stable if it is only digits and dots (`1.21.11` yes;
`1.21.11-rc3`, `26.3-rc-3` no).

Order: newest first. Where the source doesn't order, `compareVersions` compares by numeric
components and a pre-release (`-…` suffix) goes after its release.

Spigot: itzg can no longer download it from getbukkit; it only works with `BUILD_FROM_SOURCE=true`
(BuildTools `--rev <VERSION>`), which is why the list is the BuildTools revisions. The UI warns about it
(§5).

## 3. Spec: the `build` field

- `build: string`, default `""` (= the latest, current behavior). It goes in `baseFields`
  (shared) and in `Spec` (Go, `json:"build,omitempty"`); it travels in templates. No `.proto` change
  (the spec travels as JSON in `ServerSpec`).
- Identical validation in zod and Go, with shared fixture `proto/fixtures/build-cases.json`:
  - `""` or `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`.
  - Non-empty only with `type` ∈ {PAPER, FOLIA, PURPUR, FABRIC, QUILT, FORGE, NEOFORGE}; otherwise:
    “The X type does not support pinning the build (only Paper, Folia, Purpur, Fabric, Quilt, Forge and NeoForge)”.
  - Non-empty requires a concrete `version` (neither `LATEST` nor `SNAPSHOT`, case-insensitive):
    “To pin the build choose a specific Minecraft version (not LATEST or SNAPSHOT)”.
  - Non-empty forbids in `env` the variable it generates (ops/whitelist pattern): “Remove the X variable
    from the environment variables (Advanced): it is set by the Build field”.
- PATCH: first-level key with a default value; `null` → 400 (required key).
- Mapping (agent, `envList`, after `contentEnv`, before `env`): PAPER→`PAPER_BUILD`,
  FOLIA→`FOLIABUILD`, PURPUR→`PURPUR_BUILD`, FABRIC→`FABRIC_LOADER_VERSION`,
  QUILT→`QUILT_LOADER_VERSION`, FORGE→`FORGE_VERSION`, NEOFORGE→`NEOFORGE_VERSION`. Empty emits
  nothing: the hash of existing containers does not change.
- Import (`import/propose.ts`): if `env` carries the detected type's variable with a value that
  satisfies the regex and the version is concrete, it moves to `build` and leaves `env` (same final environment,
  same hash). Otherwise it stays in `env`.
- The main spec §4.1 adds `build` to the example and to the list of generated variables.

## 4. API: module `panel/apps/api/src/versions/`

- `sources.ts`: one adapter per type with `versions(fetchJson)` and, if applicable,
  `builds(version, fetchJson)`, returning already-ordered `{ id, stable, recommended? }[]`. Pure
  apart from the injected `fetchJson`; tests with trimmed documents having the exact shape of the real
  responses, inline in the test itself.
- `catalog.ts` — `VersionCatalog` (decorated as `app.versions` in `buildApp`):
  - In-memory cache per source URL: version lists (and the shared Forge and NeoForge
    documents) 1 h; build endpoints 15 min. At most 256 entries; when full, the
    least recently used is discarded.
  - Concurrent requests to the same URL share the in-flight promise.
  - 10 s deadline, response ≤ 8 MiB, `User-Agent: mc-server-manager (self-hosted)` (Fill v3 asks for
    a descriptive User-Agent), HTTPS only to the hosts in §2.
  - Source failure (network, deadline, non-2xx, invalid JSON): if there is an expired entry it is served with
    `stale: true`; otherwise `HttpError(502, "Could not query the version list of <Type>")`.
  - Injectable clock and `fetch`.
- `routes.ts` (encapsulated, behind the session guard):
  - `GET /api/versions/:type` → `{ type, versions: {id, stable}[], fetchedAt, stale }`.
  - `GET /api/versions/:type/:version/builds` → `{ type, version, builds: {id, stable, recommended}[], fetchedAt, stale }`.
  - `:type` outside {VANILLA, PAPER, FOLIA, PURPUR, SPIGOT, FABRIC, QUILT, FORGE, NEOFORGE} → 400
    “Type without a version list”; builds of a type without build → 400 “The X type does not support
    pinning the build (…)”; `:version` outside `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$` → 400. The version is encoded
    with `encodeURIComponent` when building the source URL.
  - `fetchedAt` in ISO with the panel's time.

## 5. Web

- shadcn components `command` and `popover` (`pnpm dlx shadcn@3.8.5 add command popover`; adds
  `cmdk`).
- `components/spec-form/version-picker.tsx` replaces the version `Input` in `VersionSection`
  for the types in §2 (modpacks and unknown types keep the `Input`):
  - Button with the current version; when opened, a search box and groups “Special” (`LATEST`; `SNAPSHOT`
    only on VANILLA, FABRIC and QUILT), “Stable” and “Snapshots and pre-releases” (the latter only with the
    “Show test versions” switch, off by default and on if the current version is unstable).
    While searching (text typed) matching test versions are also listed with the switch off:
    that is the real behavior and it improves usability (someone typing “26.4-snap” wants
    them).
  - Typed text that matches no option and satisfies the `:version` regex appears as
    “Use “x””.
  - States: “Loading versions…”; error → message + free text; `stale` → “The source is not
    responding; list from N ago”.
- `components/spec-form/build-picker.tsx`: `Select` with “(the latest)” + builds (Forge marks
  “recommended”; unstable Fabric/Quilt/NeoForge ones with the same switch). Label per
  type (“Paper build”, “Fabric loader version”, “Forge version”…). Hidden for types
  without build; without options and with a hint if the version is `LATEST`/`SNAPSHOT`.
- Pure logic with tests:
  - shared `minJavaTag(version)`: `LATEST`/`SNAPSHOT` and major ≥ 26 (`26.3`, `26.4-snapshot-3`,
    `26.3-rc-3`) → `java25`; `1.20.5`–`1.21.x` → `java21`; `1.17`–`1.20.4` → `java17`; `< 1.17` →
    `java8`; old snapshots `AAwSSl`: ≥ `24w14a` → `java21`, ≥ `21w19a` → `java17`, rest →
    `java8`; any other form → `null`.
  - `spec-edit.ts` `withVersion(spec, v)` → `{ spec, notice }`: clears `build`; if `imageTag` ∈
    `JAVA_TAGS` and `minJavaTag(v)` differs, it changes it and warns (“Java adjusted to java25 (the one 26.3
    requires)”); if the tag is something else (e.g. `java21-graalvm`) it doesn't touch it and warns only if its
    `javaNN` is lower than the one needed. `withType` also clears `build`.
  - `lib/versions.ts`: `versionOptions(list, { query, showUnstable })`, `freeTextOption`,
    `buildLabel(type)`.
- `hooks/use-versions.ts`: `useVersions(type)` and `useBuilds(type, version)` (TanStack Query,
  `staleTime` 10 min, `apiPath`).
- Corrected Java hint: “java25 for 26.x; java21 for 1.20.5–1.21.x; java17 for 1.17–1.20.4;
  java8 for older ones”. With type SPIGOT, a warning: “itzg no longer downloads Spigot automatically:
  add BUILD_FROM_SOURCE=true to the environment variables (Advanced) or use Paper”.
- `summarizeSpec` (wizard step 3) adds the “Build” line if it is pinned.

## 6. Tests

- shared: `build` validation (shared fixture), prohibition in `env`, `minJavaTag`.
- Agent: `Validate` with the fixture, per-type mapping in `envList`, `TestHashGolden` intact.
- API: adapters against fixtures; `VersionCatalog` (TTL, `stale`, shared promise, deadline,
  size cap, LRU) with fake clock and `fetch`; routes (400 for type/version, 502, session);
  import (`env` → `build`).
- Web: pure functions; SSR render of `VersionSection` (picker for Paper, `Input` for modpack,
  Spigot warning, Java hint).
- E2E: the wizard creates a server choosing the version by text (“Use “1.21.4”” or the list
  option, depending on network) and leaves a screenshot of the open combobox.

## 7. Out of scope

A warning when downgrading an existing server's version; pinning the Fabric/Quilt launcher/installer; experimental
Paper/Folia builds (they would need `*_CHANNEL`); modpack versions.
