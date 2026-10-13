# MC Server Manager — Plan 3: Full configuration and templates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure from the web everything that spec §4.1 allows (modpack, mods, plugins, whitelist, ops, ~20 typed properties, network, resources, free env) with a form by sections and a diff before applying, and save/instantiate templates with a three-step new-server wizard.

**Architecture:** The spec grows with five optional sections (`modpack`, `mods`, `plugins`, `whitelist`, `ops`) validated the same way in Go and in zod (a shared JSON case table guarantees it) and translated by `BuildContainer` into itzg variables; a missing section emits nothing, so the hash of existing specs does not change. The spec `PATCH` becomes a first-level merge (each screen sends only what it edits). The CurseForge API key lives in `settings` and is only added to the spec in the message to the agent. Templates are specs without `ports` or `rconPassword` in a new table. The web replaces the flat form of Plan 1 with `SpecForm` (tabs per section) and the one-step wizard with a three-step one.

**Tech Stack:** Go 1.27.2 (agent, `internal/spec`); Node 26, pnpm 12, Fastify 5, `node:sqlite`, zod 4.6 (with `z.locales.es()`); React 19, TanStack Router/Query, shadcn/ui (Radix), Vitest 4 (includes server-side rendering with `react-dom/server` for component smoke tests). No protocol changes.

**Spec:** `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md` (§4.1 in full, §4 `templates` and `settings`, §8 section-based form, wizard and Templates, §9). Scope and acceptance: `docs/superpowers/plans/README.md` (Plan 3). Coordination: `docs/superpowers/plans/COORDINATION.md`.

## Global Constraints

- Branch `feat/plan-3` in `.worktrees/plan-3`, from Plan 1 integrated **with the anchors** of the wave A preparation commit. Toolchain: `eval "$(mise env)"` before `go`/`buf`; Node 26 and pnpm 12 globally.
- Shared files: this plan writes **below the `plan-3` anchors** (`// ── plan-3 ──` in TS/Go; in the `migrations` array it is the same comment in TS). The few edits outside the anchor are flagged in each task with “(outside the anchor)”.
- Protocol: **no changes**. The spec travels as JSON in `ServerSpec.spec_json`; the `Envelope.body` range 40–49 stays free. `pnpm gen` is not needed.
- Migrations: `020_cf_api_key_env_to_settings` and `021_templates` (range 020–029), in that order, below the `plan-3` anchor of the `migrations` array.
- Exact spec fields (all optional; missing = nothing is emitted): `modpack {platform: MODRINTH|AUTO_CURSEFORGE|FTBA, slugOrUrl, versionId, loader}`, `mods {modrinthProjects[], curseforgeFiles[], urls[]}`, `plugins {modrinthProjects[], spigetResources[], urls[]}`, `whitelist {enabled, players[]}`, `ops[]`. `type` must equal `modpack.platform` when there is a modpack, and a modpack `type` requires `modpack`.
- `CF_API_KEY` becomes a **reserved** variable (it cannot be set in `env`). The global key lives in `settings.curseforge_api_key`, is managed with `GET/PUT /api/settings/curseforge` (which only return `{configured}`), and is only injected as the `curseforgeApiKey` field in the `spec_json` sent to the agent, and only if the spec uses CurseForge.
- `PATCH /api/servers/:id` and `PATCH /api/templates/:id`: `spec` is a **first-level merge** (a key present replaces, `null` deletes, a missing key is kept). The form only sends the `FORM_KEYS` keys that changed; **never** `backups` (Plan 4) nor keys it does not know.
- Templates: same shape as the server spec **without `ports` or `rconPassword`** (spec §4 `templates`); the panel assigns port and RCON when instantiating.
- The form has **no** Backups section (it belongs to Plan 4, the Backups tab). `panel/apps/api/src/auth/**` is not touched.
- UI and error messages in English (zod configured with `z.locales.es()` in `@mcsm/shared`); identifiers in English.
- Conventional commits, small, with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or the one of the model implementing the task). Never `git push`, `--no-verify` or rewriting history.
- Docker on the development machine: the end-to-end verification only creates resources with the prefix `mcsm-test-` (servers with slug `test-…`, compose project `mcsm-test-p3`) and deletes them when finished.

## Review Focus

1. **Go and zod do not accept exactly the same thing** (modpack with an incompatible `type`, entries with Unicode spaces, `whitelist` without `enabled`) → the panel saves a spec the agent rejects and the server stays in `observed.error`. It is fixed with the shared table `proto/fixtures/spec-content-cases.json`, which the Go tests (Task 1) and the zod tests (Task 2) run, and with ASCII-only regexes (no `\s`, which does not mean the same in RE2 and in JS).
2. **Updating the agent recreates all containers** because the hash of specs that use nothing new changes → restart of all servers. Test in Task 1: golden hash `6a5a213aad161661` of `spec-example.json`; `ops: []`, the CurseForge key on servers without CurseForge, reordering or duplicating mods and unknown fields (`backups`) do not change the hash; changing the key does recreate those that use CurseForge.
3. **A partial PATCH overwrites what it does not edit** (the Plan 4 Backups tab sends only `backups` and the panel resets type and memory; or the form deletes `backups` when saving) → lost configuration. Tests in Task 3 (merge, `null`, same spec does not version, `rconPassword` immutable, `__proto__`) and Task 6 (`buildSpecPatch` only touches `FORM_KEYS`).
4. **The CurseForge API key reaches the browser** (listings, detail, settings `GET`, free env) → leaked secret. Tests in Task 4 (it does not appear in any DTO nor in `servers.spec`; only CurseForge specs receive it; migration that removes it from the free env) and Task 1 (`$` stays literal).
5. **A template drags along ports or the RCON password** → two servers on the same node clash or share RCON. Tests in Task 5 (saving from a server and creating from a spec discard `ports`/`rconPassword`; instantiating gives a free port and a new RCON; the rest identical) and real verification in Task 12.
6. **Removing something in the UI does not remove it from the server** (disabling the whitelist, deleting the last Modrinth mod, removing someone from the whitelist) → the server keeps the old state. Tests in Task 1 (explicit `ENABLE_WHITELIST=false`, `MODRINTH_PROJECTS` empty when the section exists, `EXISTING_WHITELIST_FILE=SYNCHRONIZE`) and Task 7 (the mods section is kept empty instead of disappearing).

---

## Mapping spec → itzg variables (verified in `itzg/docker-minecraft-server` master, 2026-10-12)

| Spec | Variables | Notes (source) |
|---|---|---|
| `type` with modpack | `TYPE=MODRINTH\|AUTO_CURSEFORGE\|FTBA` | `scripts/start-configuration` copies `TYPE` to `MODPACK_PLATFORM`; also emitting `MODPACK_PLATFORM` with `TYPE≠VANILLA` only gives the warning «Avoid setting TYPE and MODPACK_PLATFORM». **Conscious deviation** from the plans README, which listed `MODPACK_PLATFORM`: it is not emitted. |
| `modpack` Modrinth | `MODRINTH_MODPACK`, `MODRINTH_VERSION`, `MODRINTH_LOADER` | Loader: `fabric\|forge\|quilt\|neoforge` (`ModpackLoader` of mc-image-helper). Empty = not pinned. |
| `modpack` CurseForge | `CF_SLUG` or `CF_PAGE_URL` (if it starts with `http`), `CF_FILE_ID` | The file pins the loader; there is no loader of its own. `CF_API_KEY` optional in java17+ images (they bring one). |
| `modpack` FTB | `FTB_MODPACK_ID`, `FTB_MODPACK_VERSION_ID` | Numeric (`start-deployFTBA`). |
| `mods.modrinthProjects` + `plugins.modrinthProjects` | `MODRINTH_PROJECTS` | Comma-separated, sorted and without duplicates. With the section present it is emitted **even if empty**: `[[ -v MODRINTH_PROJECTS ]]` with an empty list removes what was installed. |
| `mods.curseforgeFiles` | `CURSEFORGE_FILES` | Only if not empty. |
| `mods.urls` / `plugins.urls` | `MODS` / `PLUGINS` | Only if not empty. Removing a URL does not delete the `.jar` already copied. |
| `plugins.spigetResources` | `SPIGET_RESOURCES` | Numeric ids. |
| `whitelist` | `ENABLE_WHITELIST=true\|false`, `WHITELIST`, `EXISTING_WHITELIST_FILE=SYNCHRONIZE` | `ENABLE_WHITELIST=true` also enables `enforce-whitelist` (`start-setupServerProperties`). An explicit `false` disables a previous whitelist. Without a list `WHITELIST` is not emitted (it does not empty the file). |
| `ops` | `OPS`, `EXISTING_OPS_FILE=SYNCHRONIZE` | Empty list = not emitted (does not touch `ops.json`). |
| `settings.curseforge_api_key` | `CF_API_KEY` | Only if the spec uses CurseForge (modpack `AUTO_CURSEFORGE` or `mods.curseforgeFiles`). Through the Docker API the `$` are not escaped. |

The free `env` still wins over everything generated (e.g. `EXISTING_WHITELIST_FILE=MERGE` to add instead of synchronizing), except for the reserved ones.

## File structure

```
proto/fixtures/spec-modded.json                 valid spec with all sections (Go and TS)
proto/fixtures/spec-content-cases.json          valid/invalid case table shared Go↔zod

agent/internal/spec/content.go                  Modpack/ModSources/PluginSources/Whitelist types, validation and itzg env
agent/internal/spec/content_test.go
agent/internal/spec/spec.go                     (mod) fields under the anchor, Validate, envList, reserved CF_API_KEY

panel/packages/shared/src/spec-content.ts       zod of the sections + contentCheck + usesCurseForge
panel/packages/shared/src/spec-content.test.ts
panel/packages/shared/src/zod-locale.ts         z.config(z.locales.es())
panel/packages/shared/src/spec-patch.ts         mergeSpecPatch, canonicalJson, formatZodError, specPatchSchema
panel/packages/shared/src/spec-patch.test.ts
panel/packages/shared/src/templates.ts          template schemas, specToTemplate, copyName
panel/packages/shared/src/templates.test.ts
panel/packages/shared/src/spec.ts               (mod) fields, specChecks, serverPatchSchema, templateSpecSchema
panel/packages/shared/src/index.ts              (mod) exports

panel/apps/api/src/servers/service.ts           (mod) PATCH with merge, CF key when pushing, reapplyCurseForge
panel/apps/api/src/servers/repo.ts              (mod) toServerSpecMessage(row, {curseforgeApiKey}), bumpVersion
panel/apps/api/src/servers/patch.test.ts
panel/apps/api/src/agents/service.ts            (mod) SyncSpecs with the CF key
panel/apps/api/src/curseforge/{repo.ts,routes.ts,curseforge.test.ts}
panel/apps/api/src/templates/{repo.ts,routes.ts,templates.test.ts}
panel/apps/api/src/app.ts                       (mod) decorations and routes under the anchor
panel/apps/api/src/db/migrations.ts             (mod) 020_*, 021_*

panel/apps/web/src/lib/spec-catalog.ts          server types, Java, restart, ~20 typed properties
panel/apps/web/src/lib/spec-edit.ts             editable state, lists/kv, withType, buildSpecPatch, validateSpec
panel/apps/web/src/lib/spec-diff.ts             readable diff for the “Apply” dialog
panel/apps/web/src/lib/wizard.ts                wizard request and summary
panel/apps/web/src/lib/api.ts                   (mod) api.put, TemplateDto
panel/apps/web/src/components/spec-form/{fields,curseforge-key,version-section,properties-section,players-section,network-section,resources-section,advanced-section,spec-form}.tsx
panel/apps/web/src/components/save-template-dialog.tsx
panel/apps/web/src/components/server-config-form.tsx   (replaces the one from Plan 1)
panel/apps/web/src/hooks/use-templates.ts
panel/apps/web/src/routes/{templates.tsx,template-edit.tsx,new-server.tsx}
panel/apps/web/src/router.tsx, components/layout.tsx  (mod)
panel/apps/web/src/lib/spec-form.ts(+test)      (deleted in Task 10: replaced by spec-edit.ts)
```

## Order and dependencies

The tasks go in order on a single branch. Task 1 creates the fixtures that Task 2 reads. The web tasks (6–11) need the types and endpoints of Tasks 2, 3 and 5. Task 12 closes the plan.

---

### Task 1: Agent — content sections of the spec and their translation to itzg variables

**Agent:** go-agent-dev

**Files:**
- Create: `proto/fixtures/spec-modded.json`, `proto/fixtures/spec-content-cases.json`, `agent/internal/spec/content.go`, `agent/internal/spec/content_test.go`
- Modify: `agent/internal/spec/spec.go` (struct `Spec`, `Validate`, `envList` under the `plan-3` anchors; `ReservedEnv` outside the anchor)

**Interfaces:**
- Consumes: `spec.Spec`, `spec.Parse`, `spec.BuildContainer(meta, s, dataRoot, network)`, `(Spec).envList()` and the test helpers `loadFixture`, `meta`, `envMap` from `spec_test.go` (Plan 1).
- Produces (Go): types `spec.Modpack{Platform, SlugOrURL, VersionID, Loader}`, `spec.ModSources{ModrinthProjects, CurseforgeFiles, URLs}`, `spec.PluginSources{ModrinthProjects, SpigetResources, URLs}`, `spec.Whitelist{Enabled, Players}`; fields `Spec.Modpack *Modpack`, `Spec.Mods *ModSources`, `Spec.Plugins *PluginSources`, `Spec.Whitelist *Whitelist`, `Spec.Ops []string`, `Spec.CurseForgeAPIKey string` (JSON `curseforgeApiKey`); `(Spec).UsesCurseForge() bool`; constants `PlatformModrinth`, `PlatformAutoCurseForge`, `PlatformFTBA`; `ReservedEnv["CF_API_KEY"]`.
- Produces (fixtures): `proto/fixtures/spec-modded.json` and `proto/fixtures/spec-content-cases.json` (array of `{name, ok, merge}`: `merge` is merged into the root of `spec-example.json`), which Task 2 runs with zod.

- [ ] **Step 1: Shared fixtures**

`proto/fixtures/spec-modded.json` (the duplicates and the disorder are deliberate: the agent must sort and deduplicate):
```json
{
  "imageTag": "java21",
  "type": "MODRINTH",
  "version": "1.21.1",
  "memory": "6G",
  "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric", "versionId": "", "loader": "fabric" },
  "mods": { "modrinthProjects": ["lithium", "ferritecore:beta", "lithium"], "curseforgeFiles": [], "urls": [] },
  "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [] },
  "properties": { "motd": "Modpack de casa", "max-players": "8" },
  "whitelist": { "enabled": true, "players": ["Steve", "Lobo"] },
  "ops": ["Lobo"],
  "env": {},
  "ports": { "game": 25566, "extra": [] },
  "resources": { "cpus": 0, "memLimit": "8G" },
  "restartPolicy": "unless-stopped",
  "rconPassword": "s3cretpassw0rd"
}
```

`proto/fixtures/spec-content-cases.json`:
```json
[
  { "name": "Modrinth modpack with type MODRINTH", "ok": true,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric" } } },
  { "name": "modpack with type PAPER", "ok": false,
    "merge": { "modpack": { "platform": "MODRINTH", "slugOrUrl": "cobblemon-fabric" } } },
  { "name": "type MODRINTH without modpack", "ok": false,
    "merge": { "type": "MODRINTH" } },
  { "name": "type AUTO_CURSEFORGE with a Modrinth modpack", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x" } } },
  { "name": "unknown modpack platform", "ok": false,
    "merge": { "type": "CURSEFORGE", "modpack": { "platform": "CURSEFORGE", "slugOrUrl": "x" } } },
  { "name": "empty slugOrUrl", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "" } } },
  { "name": "slugOrUrl with a space", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "mi pack" } } },
  { "name": "neoforge loader on Modrinth", "ok": true,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x", "versionId": "abc123", "loader": "neoforge" } } },
  { "name": "unknown loader on Modrinth", "ok": false,
    "merge": { "type": "MODRINTH", "modpack": { "platform": "MODRINTH", "slugOrUrl": "x", "loader": "liteloader" } } },
  { "name": "loader on a CurseForge modpack", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "all-the-mods-10", "loader": "forge" } } },
  { "name": "CurseForge by URL with numeric fileId", "ok": true,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10", "versionId": "6013341" } } },
  { "name": "CurseForge with non-numeric fileId", "ok": false,
    "merge": { "type": "AUTO_CURSEFORGE", "modpack": { "platform": "AUTO_CURSEFORGE", "slugOrUrl": "all-the-mods-10", "versionId": "v1.2" } } },
  { "name": "FTBA with numeric ids", "ok": true,
    "merge": { "type": "FTBA", "modpack": { "platform": "FTBA", "slugOrUrl": "126", "versionId": "100" } } },
  { "name": "FTBA with a slug instead of an id", "ok": false,
    "merge": { "type": "FTBA", "modpack": { "platform": "FTBA", "slugOrUrl": "ftb-skies" } } },
  { "name": "valid mods", "ok": true,
    "merge": { "mods": { "modrinthProjects": ["lithium", "fabric:sodium", "ferritecore:beta"], "curseforgeFiles": ["jei:4593548"], "urls": ["https://example.com/mods/a.jar"] } } },
  { "name": "empty mods", "ok": true, "merge": { "mods": {} } },
  { "name": "Modrinth project with a comma", "ok": false,
    "merge": { "mods": { "modrinthProjects": ["lithium,sodium"] } } },
  { "name": "Modrinth project with a space", "ok": false,
    "merge": { "mods": { "modrinthProjects": ["lithium sodium"] } } },
  { "name": "empty Modrinth project", "ok": false,
    "merge": { "mods": { "modrinthProjects": [""] } } },
  { "name": "mod URL that is not http", "ok": false,
    "merge": { "mods": { "urls": ["ftp://example.com/a.jar"] } } },
  { "name": "plugin URL with a non-ASCII space", "ok": false,
    "merge": { "plugins": { "urls": ["https://example.com/a b.jar"] } } },
  { "name": "numeric Spiget resources", "ok": true,
    "merge": { "plugins": { "spigetResources": ["28140", "34315"], "modrinthProjects": ["luckperms"] } } },
  { "name": "non-numeric Spiget resource", "ok": false,
    "merge": { "plugins": { "spigetResources": ["essentials"] } } },
  { "name": "whitelist with name and UUID", "ok": true,
    "merge": { "whitelist": { "enabled": true, "players": ["Lobo", "069a79f4-44e9-4726-a5be-fca90e38aaf5"] } } },
  { "name": "whitelist without enabled (defaults to false)", "ok": true,
    "merge": { "whitelist": { "players": ["Lobo"] } } },
  { "name": "whitelist disabled with players", "ok": true,
    "merge": { "whitelist": { "enabled": false, "players": ["Lobo"] } } },
  { "name": "player with a space", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": ["Lo bo"] } } },
  { "name": "17-character player", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": ["abcdefghijklmnopq"] } } },
  { "name": "valid ops", "ok": true, "merge": { "ops": ["Lobo", "Steve"] } },
  { "name": "op with a comma", "ok": false, "merge": { "ops": ["Lobo,Steve"] } },
  { "name": "whitelist section and white-list property at the same time", "ok": false,
    "merge": { "whitelist": { "enabled": true, "players": [] }, "properties": { "white-list": "true" } } },
  { "name": "whitelist section and enforce-whitelist property at the same time", "ok": false,
    "merge": { "whitelist": { "enabled": false, "players": [] }, "properties": { "enforce-whitelist": "true" } } },
  { "name": "white-list property without whitelist section (compatibility)", "ok": true,
    "merge": { "properties": { "white-list": "true" } } },
  { "name": "CF_API_KEY in the free env", "ok": false, "merge": { "env": { "CF_API_KEY": "x" } } }
]
```

- [ ] **Step 2: Test (fails)**

`agent/internal/spec/content_test.go`:
```go
package spec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixturePath(name string) string {
	return filepath.Join("..", "..", "..", "proto", "fixtures", name)
}

func loadModded(t *testing.T) Spec {
	t.Helper()
	b, err := os.ReadFile(fixturePath("spec-modded.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func buildEnv(t *testing.T, s Spec) map[string]string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return envMap(b.Config.Env)
}

func hashOfSpec(t *testing.T, s Spec) string {
	t.Helper()
	b, err := BuildContainer(meta, s, "/srv/minecraft", "mcsm")
	if err != nil {
		t.Fatal(err)
	}
	return b.Hash
}

// Cases shared with panel/packages/shared/src/spec-content.test.ts: Go and zod must accept
// and reject exactly the same.
func TestContentCasesSharedWithZod(t *testing.T) {
	baseRaw, err := os.ReadFile(fixturePath("spec-example.json"))
	if err != nil {
		t.Fatal(err)
	}
	casesRaw, err := os.ReadFile(fixturePath("spec-content-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string                     `json:"name"`
		OK    bool                       `json:"ok"`
		Merge map[string]json.RawMessage `json:"merge"`
	}
	if err := json.Unmarshal(casesRaw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("only %d cases: is the fixture truncated?", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var doc map[string]json.RawMessage
			if err := json.Unmarshal(baseRaw, &doc); err != nil {
				t.Fatal(err)
			}
			for k, v := range c.Merge {
				doc[k] = v
			}
			b, _ := json.Marshal(doc)
			_, err := Parse(b)
			if c.OK && err != nil {
				t.Fatalf("should be accepted: %v", err)
			}
			if !c.OK && err == nil {
				t.Fatal("should be rejected")
			}
		})
	}
}

func TestContentEnvModrinthModpack(t *testing.T) {
	env := buildEnv(t, loadModded(t))
	want := map[string]string{
		"TYPE":                    "MODRINTH",
		"MODRINTH_MODPACK":        "cobblemon-fabric",
		"MODRINTH_LOADER":         "fabric",
		"MODRINTH_PROJECTS":       "ferritecore:beta,lithium",
		"ENABLE_WHITELIST":        "true",
		"WHITELIST":               "Lobo,Steve",
		"EXISTING_WHITELIST_FILE": "SYNCHRONIZE",
		"OPS":                     "Lobo",
		"EXISTING_OPS_FILE":       "SYNCHRONIZE",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	for _, k := range []string{"MODPACK_PLATFORM", "MODRINTH_VERSION", "CF_API_KEY", "MODS", "PLUGINS", "SPIGET_RESOURCES", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s should not be emitted (= %q)", k, env[k])
		}
	}
}

func TestContentEnvCurseForgeAndFTB(t *testing.T) {
	s := loadFixture(t)
	s.Type = PlatformAutoCurseForge
	s.Modpack = &Modpack{Platform: PlatformAutoCurseForge, SlugOrURL: "all-the-mods-10", VersionID: "6013341"}
	s.CurseForgeAPIKey = "$2a$10$abc/def"
	env := buildEnv(t, s)
	if env["CF_SLUG"] != "all-the-mods-10" || env["CF_FILE_ID"] != "6013341" || env["CF_PAGE_URL"] != "" {
		t.Errorf("slug: %v", env)
	}
	if env["CF_API_KEY"] != "$2a$10$abc/def" {
		t.Errorf("CF_API_KEY = %q (the $ are not escaped: the Docker API does not interpolate)", env["CF_API_KEY"])
	}

	s.Modpack.SlugOrURL = "https://www.curseforge.com/minecraft/modpacks/all-the-mods-10"
	env = buildEnv(t, s)
	if env["CF_PAGE_URL"] != s.Modpack.SlugOrURL || env["CF_SLUG"] != "" {
		t.Errorf("url: %v", env)
	}

	f := loadFixture(t)
	f.Type = PlatformFTBA
	f.Modpack = &Modpack{Platform: PlatformFTBA, SlugOrURL: "126", VersionID: "100"}
	env = buildEnv(t, f)
	if env["FTB_MODPACK_ID"] != "126" || env["FTB_MODPACK_VERSION_ID"] != "100" || env["TYPE"] != "FTBA" {
		t.Errorf("ftba: %v", env)
	}
}

func TestContentEnvModsPluginsAndWhitelistOff(t *testing.T) {
	s := loadFixture(t) // PAPER
	s.Plugins = &PluginSources{ModrinthProjects: []string{"luckperms"}, SpigetResources: []string{"34315", "28140"}, URLs: []string{"https://example.com/b.jar", "https://example.com/a.jar"}}
	s.Mods = &ModSources{CurseforgeFiles: []string{"jei:4593548"}}
	s.Whitelist = &Whitelist{Enabled: false, Players: []string{"Lobo"}}
	env := buildEnv(t, s)
	want := map[string]string{
		"MODRINTH_PROJECTS": "luckperms",
		"SPIGET_RESOURCES":  "28140,34315",
		"PLUGINS":           "https://example.com/a.jar,https://example.com/b.jar",
		"CURSEFORGE_FILES":  "jei:4593548",
		"ENABLE_WHITELIST":  "false",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%s] = %q, want %q", k, env[k], v)
		}
	}
	if _, ok := env["WHITELIST"]; ok {
		t.Error("with the whitelist disabled, WHITELIST is not emitted (itzg would enable it)")
	}
	if _, ok := env["CF_API_KEY"]; ok {
		t.Error("without an API key in the spec, CF_API_KEY is not emitted")
	}
}

func TestFreeEnvWinsOverGenerated(t *testing.T) {
	s := loadModded(t)
	s.Env = map[string]string{"EXISTING_WHITELIST_FILE": "MERGE"}
	if env := buildEnv(t, s); env["EXISTING_WHITELIST_FILE"] != "MERGE" {
		t.Errorf("the free env must win: %q", env["EXISTING_WHITELIST_FILE"])
	}
}

// The hash only changes when the container changes.
func TestContentHash(t *testing.T) {
	base := loadFixture(t)
	h0 := hashOfSpec(t, base)
	// Value computed with the Plan 1 code for spec-example.json: if it changes, updating the
	// agent would recreate ALL existing containers. It can only change if the version of
	// github.com/moby/moby/api is updated.
	if h0 != "6a5a213aad161661" {
		t.Fatalf("the hash of a spec without new fields changed: %s", h0)
	}

	noOps := base
	noOps.Ops = []string{}
	if hashOfSpec(t, noOps) != h0 {
		t.Error("empty ops must not change the hash")
	}

	withKey := base
	withKey.CurseForgeAPIKey = "k"
	if hashOfSpec(t, withKey) != h0 {
		t.Error("the CurseForge API key must not affect servers that do not use CurseForge")
	}

	a := base
	a.Mods = &ModSources{ModrinthProjects: []string{"lithium", "sodium"}}
	b := base
	b.Mods = &ModSources{ModrinthProjects: []string{"sodium", "lithium", "lithium"}}
	if hashOfSpec(t, a) != hashOfSpec(t, b) {
		t.Error("reordering or duplicating mods must not recreate the container")
	}
	if hashOfSpec(t, a) == h0 {
		t.Error("adding mods must change the hash")
	}

	cf := base
	cf.Mods = &ModSources{CurseforgeFiles: []string{"jei"}}
	cf1, cf2 := cf, cf
	cf1.CurseForgeAPIKey = "uno"
	cf2.CurseForgeAPIKey = "dos"
	if hashOfSpec(t, cf1) == hashOfSpec(t, cf2) {
		t.Error("changing the API key must recreate the servers that use CurseForge")
	}
}

// Removing the last mod must reach itzg as an empty MODRINTH_PROJECTS (it removes what was
// installed); without the section, the variable does not exist and itzg does not touch anything.
func TestEmptyModsSectionClearsModrinthProjects(t *testing.T) {
	s := loadFixture(t)
	if _, ok := buildEnv(t, s)["MODRINTH_PROJECTS"]; ok {
		t.Fatal("without a mods/plugins section MODRINTH_PROJECTS must not exist")
	}
	s.Mods = &ModSources{}
	env := buildEnv(t, s)
	if v, ok := env["MODRINTH_PROJECTS"]; !ok || v != "" {
		t.Errorf("MODRINTH_PROJECTS = %q (present=%v), want it empty and present", v, ok)
	}
	for _, k := range []string{"MODS", "CURSEFORGE_FILES"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s empty must not be emitted", k)
		}
	}
}

func TestParseIgnoresUnknownFields(t *testing.T) {
	// Fields from other plans (e.g. backups) must not break this plan's agent.
	raw, _ := os.ReadFile(fixturePath("spec-example.json"))
	var doc map[string]json.RawMessage
	_ = json.Unmarshal(raw, &doc)
	doc["backups"] = json.RawMessage(`{"enabled":true,"cron":"0 4 * * *"}`)
	b, _ := json.Marshal(doc)
	s, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if hashOfSpec(t, s) != "6a5a213aad161661" {
		t.Error("an unknown field must not change the hash")
	}
	if !strings.Contains(string(b), "backups") {
		t.Fatal("fixture built wrongly")
	}
}
```

- [ ] **Step 3: Run (must fail)**

```bash
eval "$(mise env)" && cd agent && go test ./internal/spec/
```
Expected: compile FAIL (`undefined: ModSources`, `s.Modpack undefined`…).

- [ ] **Step 4: Sections implementation**

`agent/internal/spec/content.go`:
```go
package spec

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Modpack platforms. The image's TYPE is the platform itself: itzg
// (scripts/start-configuration) copies TYPE=MODRINTH|AUTO_CURSEFORGE|FTBA to
// MODPACK_PLATFORM, and also emitting MODPACK_PLATFORM with TYPE≠VANILLA only
// produces the warning "Avoid setting TYPE and MODPACK_PLATFORM". That is why it is not emitted.
const (
	PlatformModrinth       = "MODRINTH"
	PlatformAutoCurseForge = "AUTO_CURSEFORGE"
	PlatformFTBA           = "FTBA"
)

// ModpackPlatforms are the valid values of modpack.platform (and of type when there is a modpack).
var ModpackPlatforms = map[string]bool{PlatformModrinth: true, PlatformAutoCurseForge: true, PlatformFTBA: true}

// ModrinthLoaders are the MODRINTH_LOADER values that mc-image-helper accepts ("" = not pinned).
var ModrinthLoaders = map[string]bool{"": true, "fabric": true, "forge": true, "quilt": true, "neoforge": true}

var (
	// listEntryRe: printable ASCII without spaces or commas (lists are joined with commas).
	// The same pattern is in zod; do not use \s, which does not mean the same in Go (RE2) and in JS.
	listEntryRe = regexp.MustCompile(`^[!-+\--~]{1,300}$`)
	urlRe       = regexp.MustCompile(`^https?://[!-+\--~]{1,1000}$`)
	digitsRe    = regexp.MustCompile(`^[0-9]{1,12}$`)
	// playerRe: Java profile name (1-16 letters, digits or _) or UUID with or without hyphens.
	playerRe = regexp.MustCompile(`^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$`)
)

// whitelistProps are managed by the whitelist section through env; they cannot also go in properties.
var whitelistProps = []string{"white-list", "enforce-whitelist"}

type Modpack struct {
	Platform  string `json:"platform"`
	SlugOrURL string `json:"slugOrUrl"`
	VersionID string `json:"versionId"`
	Loader    string `json:"loader"`
}

type ModSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	CurseforgeFiles  []string `json:"curseforgeFiles"`
	URLs             []string `json:"urls"`
}

type PluginSources struct {
	ModrinthProjects []string `json:"modrinthProjects"`
	SpigetResources  []string `json:"spigetResources"`
	URLs             []string `json:"urls"`
}

type Whitelist struct {
	Enabled bool     `json:"enabled"`
	Players []string `json:"players"`
}

type listRule struct {
	name  string
	items []string
	re    *regexp.Regexp
}

// UsesCurseForge reports whether the spec downloads anything from CurseForge (and therefore receives CF_API_KEY).
func (s Spec) UsesCurseForge() bool {
	return (s.Modpack != nil && s.Modpack.Platform == PlatformAutoCurseForge) ||
		(s.Mods != nil && len(s.Mods.CurseforgeFiles) > 0)
}

func (s Spec) validateContent() error {
	if err := s.validateModpack(); err != nil {
		return err
	}
	var rules []listRule
	if s.Mods != nil {
		rules = append(rules,
			listRule{"mods.modrinthProjects", s.Mods.ModrinthProjects, listEntryRe},
			listRule{"mods.curseforgeFiles", s.Mods.CurseforgeFiles, listEntryRe},
			listRule{"mods.urls", s.Mods.URLs, urlRe})
	}
	if s.Plugins != nil {
		rules = append(rules,
			listRule{"plugins.modrinthProjects", s.Plugins.ModrinthProjects, listEntryRe},
			listRule{"plugins.spigetResources", s.Plugins.SpigetResources, digitsRe},
			listRule{"plugins.urls", s.Plugins.URLs, urlRe})
	}
	rules = append(rules, listRule{"ops", s.Ops, playerRe})
	if s.Whitelist != nil {
		rules = append(rules, listRule{"whitelist.players", s.Whitelist.Players, playerRe})
		for _, k := range whitelistProps {
			if _, ok := s.Properties[k]; ok {
				return fmt.Errorf("spec: property %s is managed from the whitelist section", k)
			}
		}
	}
	for _, r := range rules {
		for _, it := range r.items {
			if !r.re.MatchString(it) {
				return fmt.Errorf("spec: invalid entry in %s: %q", r.name, it)
			}
		}
	}
	return nil
}

func (s Spec) validateModpack() error {
	mp := s.Modpack
	if mp == nil {
		if ModpackPlatforms[s.Type] {
			return fmt.Errorf("spec: type %s requires a modpack", s.Type)
		}
		return nil
	}
	if !ModpackPlatforms[mp.Platform] {
		return fmt.Errorf("spec: invalid modpack.platform %q (MODRINTH|AUTO_CURSEFORGE|FTBA)", mp.Platform)
	}
	if s.Type != mp.Platform {
		return fmt.Errorf("spec: a %s modpack requires type=%s (current type %q)", mp.Platform, mp.Platform, s.Type)
	}
	if !listEntryRe.MatchString(mp.SlugOrURL) {
		return fmt.Errorf("spec: modpack.slugOrUrl is required, without spaces or commas")
	}
	if mp.VersionID != "" && !listEntryRe.MatchString(mp.VersionID) {
		return fmt.Errorf("spec: invalid modpack.versionId %q", mp.VersionID)
	}
	if mp.Platform != PlatformModrinth && mp.Loader != "" {
		return fmt.Errorf("spec: modpack.loader can only be chosen for Modrinth modpacks")
	}
	switch mp.Platform {
	case PlatformModrinth:
		if !ModrinthLoaders[mp.Loader] {
			return fmt.Errorf("spec: invalid modpack.loader %q (fabric|forge|quilt|neoforge)", mp.Loader)
		}
	case PlatformAutoCurseForge:
		if mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID) {
			return fmt.Errorf("spec: for CurseForge, modpack.versionId is the numeric id of the file")
		}
	case PlatformFTBA:
		if !digitsRe.MatchString(mp.SlugOrURL) || (mp.VersionID != "" && !digitsRe.MatchString(mp.VersionID)) {
			return fmt.Errorf("spec: FTB modpacks are given by their numeric id (and numeric version)")
		}
	}
	return nil
}

// contentEnv adds to m the itzg variables for modpack, mods, plugins, whitelist and ops.
// A missing section emits nothing: specs prior to this plan keep their hash.
func (s Spec) contentEnv(m map[string]string) {
	if mp := s.Modpack; mp != nil {
		switch mp.Platform {
		case PlatformModrinth:
			m["MODRINTH_MODPACK"] = mp.SlugOrURL
			setIf(m, "MODRINTH_VERSION", mp.VersionID)
			setIf(m, "MODRINTH_LOADER", mp.Loader)
		case PlatformAutoCurseForge:
			if strings.HasPrefix(mp.SlugOrURL, "http://") || strings.HasPrefix(mp.SlugOrURL, "https://") {
				m["CF_PAGE_URL"] = mp.SlugOrURL
			} else {
				m["CF_SLUG"] = mp.SlugOrURL
			}
			setIf(m, "CF_FILE_ID", mp.VersionID)
		case PlatformFTBA:
			m["FTB_MODPACK_ID"] = mp.SlugOrURL
			setIf(m, "FTB_MODPACK_VERSION_ID", mp.VersionID)
		}
	}
	if s.Mods != nil || s.Plugins != nil {
		var mods, plugins []string
		if s.Mods != nil {
			mods = s.Mods.ModrinthProjects
		}
		if s.Plugins != nil {
			plugins = s.Plugins.ModrinthProjects
		}
		// With the section present it is emitted even if empty: itzg then removes what it
		// installed from Modrinth (removing the last mod in the UI removes it from the server).
		m["MODRINTH_PROJECTS"] = joinList(mods, plugins)
	}
	if s.Mods != nil {
		setIf(m, "CURSEFORGE_FILES", joinList(s.Mods.CurseforgeFiles))
		setIf(m, "MODS", joinList(s.Mods.URLs))
	}
	if s.Plugins != nil {
		setIf(m, "SPIGET_RESOURCES", joinList(s.Plugins.SpigetResources))
		setIf(m, "PLUGINS", joinList(s.Plugins.URLs))
	}
	if w := s.Whitelist; w != nil {
		if w.Enabled {
			m["ENABLE_WHITELIST"] = "true"
			if list := joinList(w.Players); list != "" {
				m["WHITELIST"] = list
				// The panel is the source of truth: removing someone from the list removes them from the file.
				m["EXISTING_WHITELIST_FILE"] = "SYNCHRONIZE"
			}
		} else {
			// Explicit: without this, a whitelist enabled before would stay active in server.properties.
			m["ENABLE_WHITELIST"] = "false"
		}
	}
	if list := joinList(s.Ops); list != "" {
		m["OPS"] = list
		m["EXISTING_OPS_FILE"] = "SYNCHRONIZE"
	}
	if s.CurseForgeAPIKey != "" && s.UsesCurseForge() {
		m["CF_API_KEY"] = s.CurseForgeAPIKey
	}
}

func setIf(m map[string]string, k, v string) {
	if v != "" {
		m[k] = v
	}
}

// joinList joins the lists without duplicates, sorted and separated by commas: reordering in the
// UI does not change the env (nor the hash, nor recreate the container).
func joinList(lists ...[]string) string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, it := range l {
			if !seen[it] {
				seen[it] = true
				out = append(out, it)
			}
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}
```

- [ ] **Step 5: Connect with `spec.go`**

In `agent/internal/spec/spec.go`:

1. (outside the anchor) Add `CF_API_KEY` to `ReservedEnv` (the key is configured in Settings, not in the free env):
```go
var ReservedEnv = map[string]bool{
	"EULA": true, "TYPE": true, "VERSION": true, "MEMORY": true, "ENABLE_RCON": true,
	"RCON_PASSWORD": true, "RCON_PORT": true, "SERVER_PORT": true, "CUSTOM_SERVER_PROPERTIES": true,
	"CF_API_KEY": true,
}
```

2. At the end of the `Spec` struct, below the `// ── plan-3 ──` anchor:
```go
	// ── plan-3 ──
	// Content sections: nil = missing (nothing is emitted and the hash does not change).
	Modpack   *Modpack       `json:"modpack,omitempty"`
	Mods      *ModSources    `json:"mods,omitempty"`
	Plugins   *PluginSources `json:"plugins,omitempty"`
	Whitelist *Whitelist     `json:"whitelist,omitempty"`
	Ops       []string       `json:"ops,omitempty"`
	// CurseForgeAPIKey is added by the panel when sending the spec to the agent (Settings → CurseForge
	// API key). It is never stored in the panel's spec nor sent to the browser.
	CurseForgeAPIKey string `json:"curseforgeApiKey,omitempty"`
```

3. In `Validate()`, just before the final `return nil` (below the `plan-3` anchor if the preparation left it there):
```go
	// ── plan-3 ──
	if err := s.validateContent(); err != nil {
		return err
	}
	return nil
```

4. In `envList()`, between the block that fills `CUSTOM_SERVER_PROPERTIES` and the loop `for k, v := range s.Env` (the free env must keep winning):
```go
	// ── plan-3 ──
	s.contentEnv(m)
	for k, v := range s.Env {
```

- [ ] **Step 6: Run (must pass)**

```bash
eval "$(mise env)" && cd agent && gofmt -l ./internal/spec && go vet ./internal/spec/ && go test ./internal/spec/ -v -run 'Content|EnvLibre|EmptyMods|ParseIgnores' && go test -race ./...
```
Expected: `gofmt -l` with no output; PASS in `TestContentCasesSharedWithZod` (34 subtests), `TestContentEnvModrinthModpack`, `TestContentEnvCurseForgeAndFTB`, `TestContentEnvModsPluginsAndWhitelistOff`, `TestFreeEnvWinsOverGenerated`, `TestContentHash`, `TestEmptyModsSectionClearsModrinthProjects`, `TestParseIgnoresUnknownFields`; the rest of the packages `ok` (the Plan 1 tests do not change). If `TestContentHash` fails with a different golden hash, **do not update it**: something added is changing the container of specs without new sections (check that `contentEnv` emits nothing when everything is `nil`).

- [ ] **Step 7: Commit**

```bash
git add proto/fixtures/spec-modded.json proto/fixtures/spec-content-cases.json agent/internal/spec/
git commit -m "feat(agent): modpack, mods, plugins, whitelist and ops in the spec with their itzg variables

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared — zod schema for the content sections (mirror of the agent)

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/spec-content.ts`, `panel/packages/shared/src/spec-content.test.ts`, `panel/packages/shared/src/zod-locale.ts`
- Modify: `panel/packages/shared/src/spec.ts` (fields under the anchor `plan-3` of `baseFields`; imports, `RESERVED_ENV`, env message and `specChecks` outside the anchor), `panel/packages/shared/src/index.ts`

**Interfaces:**
- Consumes: fixtures from Task 1 (`proto/fixtures/spec-modded.json`, `proto/fixtures/spec-content-cases.json`); `baseFields`, `memLimitCheck`, `specSchema`, `specInputSchema` from `spec.ts` (Plan 1).
- Produces (`@mcsm/shared`): `MODPACK_PLATFORMS` (`readonly ["MODRINTH","AUTO_CURSEFORGE","FTBA"]`), `type ModpackPlatform`, `MODRINTH_LOADERS` (`["", "fabric","forge","quilt","neoforge"]`), `PLAYER_RE`, `modpackSchema`, `modsSchema`, `pluginsSchema`, `whitelistSchema`, `contentFields`, `contentCheck(s, ctx)`, `usesCurseForge(spec): boolean`. `Spec`/`SpecInput` gain `modpack?`, `mods?`, `plugins?`, `whitelist?`, `ops?`. `RESERVED_ENV` incluye `CF_API_KEY`. Global effect: zod messages in Spanish (`zod-locale.ts`).

- [ ] **Step 1: Test (falla)**

`panel/packages/shared/src/spec-content.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { specSchema, specInputSchema } from "./spec.js";
import { usesCurseForge } from "./spec-content.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../../proto/fixtures/${name}`, import.meta.url), "utf8"));
const base = fixture("spec-example.json");
const modded = fixture("spec-modded.json");
const cases = fixture("spec-content-cases.json") as { name: string; ok: boolean; merge: Record<string, unknown> }[];

describe("cases shared with the Go agent (proto/fixtures/spec-content-cases.json)", () => {
  it("the fixture has cases", () => expect(cases.length).toBeGreaterThanOrEqual(30));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = specSchema.safeParse({ ...base, ...c.merge });
    expect(r.success, r.success ? "" : r.error.issues[0]?.message).toBe(c.ok);
  });
});

describe("spec con contenido", () => {
  it("accepts spec-modded.json unchanged", () => {
    expect(specSchema.parse(modded)).toEqual(modded);
  });
  it("the Plan 1 spec still has no new fields after parsing (what is stored does not change)", () => {
    const parsed = specSchema.parse(base);
    for (const k of ["modpack", "mods", "plugins", "whitelist", "ops"]) expect(parsed).not.toHaveProperty(k);
  });
  it("fills in defaults within the sections present", () => {
    const parsed = specInputSchema.parse({ mods: {}, whitelist: { players: ["Lobo"] } });
    expect(parsed.mods).toEqual({ modrinthProjects: [], curseforgeFiles: [], urls: [] });
    expect(parsed.whitelist).toEqual({ enabled: false, players: ["Lobo"] });
  });
  it("drops curseforgeApiKey if it arrives from outside (it is never persisted)", () => {
    const parsed = specSchema.parse({ ...base, curseforgeApiKey: "secreto" });
    expect(parsed).not.toHaveProperty("curseforgeApiKey");
  });
  it("messages with the field path", () => {
    const r = specInputSchema.safeParse({ type: "MODRINTH" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["modpack"]);
      expect(r.error.issues[0]?.message).toMatch(/requires specifying the modpack/);
    }
  });
  it("usesCurseForge", () => {
    expect(usesCurseForge(base)).toBe(false);
    expect(usesCurseForge({ mods: { curseforgeFiles: ["jei"] } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "AUTO_CURSEFORGE" } })).toBe(true);
    expect(usesCurseForge({ modpack: { platform: "MODRINTH" } })).toBe(false);
  });
});
```

- [ ] **Step 2: Ejecutar (debe fallar)**

```bash
pnpm --filter @mcsm/shared test
```
Expected: FAIL (`Cannot find module './spec-content.js'`).

- [ ] **Step 3: Implementation**

`panel/packages/shared/src/zod-locale.ts`:
```ts
import { z } from "zod";

// zod's default messages in Spanish for the panel and the web (they share this zod instance).
z.config(z.locales.es());
```

`panel/packages/shared/src/spec-content.ts`:
```ts
import { z } from "zod";

/**
 * Content sections of the spec (§4.1): modpack, mods, plugins, whitelist and ops.
 * Exact mirror of agent/internal/spec/content.go; the cases of
 * proto/fixtures/spec-content-cases.json are tested on both sides.
 */

export const MODPACK_PLATFORMS = ["MODRINTH", "AUTO_CURSEFORGE", "FTBA"] as const;
export type ModpackPlatform = (typeof MODPACK_PLATFORMS)[number];
export const MODRINTH_LOADERS = ["", "fabric", "forge", "quilt", "neoforge"] as const;

// Printable ASCII without spaces or commas. Do not use \s: in JS it includes Unicode spaces and in Go it does not.
const ENTRY_RE = /^[!-+\--~]{1,300}$/;
const URL_RE = /^https?:\/\/[!-+\--~]{1,1000}$/;
const DIGITS_RE = /^[0-9]{1,12}$/;
export const PLAYER_RE = /^([A-Za-z0-9_]{1,16}|[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})$/;

const entry = z.string().regex(ENTRY_RE, "Invalid entry: no spaces or commas (max. 300 characters)");
const url = z.string().regex(URL_RE, "Invalid URL: must start with http:// or https:// and contain no spaces or commas");
const spigetId = z.string().regex(DIGITS_RE, "Spiget resources are numeric ids");
const player = z.string().regex(PLAYER_RE, "Invalid player: Java name (1-16 letters, digits or _) or UUID");

export const modpackSchema = z
  .object({
    platform: z.enum(MODPACK_PLATFORMS, "Invalid modpack platform (MODRINTH, AUTO_CURSEFORGE or FTBA)"),
    slugOrUrl: z.string().regex(ENTRY_RE, "Specify the modpack (slug, id or URL) with no spaces or commas"),
    versionId: z.union([z.literal(""), entry]).default(""),
    loader: z.enum(MODRINTH_LOADERS, "Invalid loader (fabric, forge, quilt or neoforge)").default(""),
  })
  .superRefine((mp, ctx) => {
    if (mp.platform !== "MODRINTH" && mp.loader !== "") {
      ctx.addIssue({ code: "custom", path: ["loader"], message: "The loader can only be chosen for Modrinth modpacks" });
    }
    if (mp.platform === "AUTO_CURSEFORGE" && mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)) {
      ctx.addIssue({ code: "custom", path: ["versionId"], message: "In CurseForge the version is the numeric file id" });
    }
    if (mp.platform === "FTBA" && (!DIGITS_RE.test(mp.slugOrUrl) || (mp.versionId !== "" && !DIGITS_RE.test(mp.versionId)))) {
      ctx.addIssue({ code: "custom", path: ["slugOrUrl"], message: "FTB modpacks are specified by their numeric id (and numeric version)" });
    }
  });

export const modsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  curseforgeFiles: z.array(entry).default([]),
  urls: z.array(url).default([]),
});

export const pluginsSchema = z.object({
  modrinthProjects: z.array(entry).default([]),
  spigetResources: z.array(spigetId).default([]),
  urls: z.array(url).default([]),
});

export const whitelistSchema = z.object({
  enabled: z.boolean().default(false),
  players: z.array(player).default([]),
});

/** Fields added to the spec (all optional: without them the spec is the Plan 1 one). */
export const contentFields = {
  modpack: modpackSchema.optional(),
  mods: modsSchema.optional(),
  plugins: pluginsSchema.optional(),
  whitelist: whitelistSchema.optional(),
  ops: z.array(player).optional(),
};

const WHITELIST_PROPS = ["white-list", "enforce-whitelist"];

type ContentShape = {
  type: string;
  properties: Record<string, string>;
  modpack?: { platform: ModpackPlatform } | undefined;
  whitelist?: unknown;
};

/** Cross validation (type ↔ modpack, whitelist ↔ properties). */
export function contentCheck(s: ContentShape, ctx: z.RefinementCtx) {
  const typeIsPlatform = (MODPACK_PLATFORMS as readonly string[]).includes(s.type);
  if (s.modpack && s.type !== s.modpack.platform) {
    ctx.addIssue({ code: "custom", path: ["type"], message: `A ${s.modpack.platform} modpack requires the type ${s.modpack.platform}` });
  }
  if (!s.modpack && typeIsPlatform) {
    ctx.addIssue({ code: "custom", path: ["modpack"], message: `The type ${s.type} requires specifying the modpack` });
  }
  if (s.whitelist) {
    for (const k of WHITELIST_PROPS) {
      if (k in s.properties) {
        ctx.addIssue({ code: "custom", path: ["properties", k], message: `The property ${k} is managed from the Players section (whitelist)` });
      }
    }
  }
}

/** Does the spec download anything from CurseForge? Only then does the panel send it CF_API_KEY. */
export function usesCurseForge(s: { modpack?: { platform: string } | undefined; mods?: { curseforgeFiles: string[] } | undefined }): boolean {
  return s.modpack?.platform === "AUTO_CURSEFORGE" || (s.mods?.curseforgeFiles.length ?? 0) > 0;
}
```

In `panel/packages/shared/src/spec.ts`:

1. (outside the anchor) Imports at the top:
```ts
import { z } from "zod";
import "./zod-locale.js";
import { contentCheck, contentFields } from "./spec-content.js";
```

2. (outside the anchor) `CF_API_KEY` in `RESERVED_ENV` and in the `envSchema` message:
```ts
export const RESERVED_ENV = new Set([
  "EULA", "TYPE", "VERSION", "MEMORY", "ENABLE_RCON", "RCON_PASSWORD", "RCON_PORT", "SERVER_PORT", "CUSTOM_SERVER_PROPERTIES",
  "CF_API_KEY",
]);
```
```ts
    message: "Contains a reserved variable (EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES, CF_API_KEY)",
```

3. At the end of `baseFields`, below the anchor:
```ts
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  // ── plan-3 ──
  ...contentFields,
};
```

4. (outside the anchor) Below `memLimitCheck`, add `specChecks` and replace **both** occurrences of `.superRefine(memLimitCheck)` (in `specSchema` and `specInputSchema`) with `.superRefine(specChecks)`:
```ts
/** Whole-object validations: memory and, below the anchors, each plan's. */
function specChecks(s: Parameters<typeof memLimitCheck>[0] & Parameters<typeof contentCheck>[0], ctx: z.RefinementCtx) {
  memLimitCheck(s, ctx);
  // ── plan-3 ──
  contentCheck(s, ctx);
}
```

In `panel/packages/shared/src/index.ts` add:
```ts
export * from "./spec-content.js";
```

- [ ] **Step 4: Ejecutar (debe pasar)**

```bash
pnpm --filter @mcsm/shared test && pnpm typecheck && pnpm --filter @mcsm/api test
```
Expected: `@mcsm/shared` PASS (the 34 shared cases give the same result as in Go, plus the Plan 1 tests unchanged); `typecheck` clean in all packages (the web compiles: the new fields are optional); the API stays green.

- [ ] **Step 5: Commit**

```bash
git add panel/packages/shared/src/
git commit -m "feat(shared): modpack, mods, plugins, whitelist and ops sections validated the same as in the agent

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Panel — spec PATCH as a top-level merge

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/spec-patch.ts`, `panel/packages/shared/src/spec-patch.test.ts`, `panel/apps/api/src/servers/patch.test.ts`
- Modify: `panel/packages/shared/src/spec.ts` (`serverPatchSchema`, outside the anchor), `panel/packages/shared/src/index.ts`, `panel/apps/api/src/servers/service.ts` (`patch`, `completeSpec` messages)

**Interfaces:**
- Consumes: `specInputSchema`, `specSchema`, `serverPatchSchema` (Task 2); `ServersService.completeSpec(nodeId, input, previous)`, `ServersRepo.updateSpec/rename` (Plan 1).
- Produces (`@mcsm/shared`): `specPatchSchema` (`z.record(z.string(), z.unknown())`), `type SpecPatch`, `mergeSpecPatch(previous, patch): Record<string, unknown>`, `canonicalJson(v): string`, `formatZodError(err): string` (`"path: message"`). `serverPatchSchema.spec` becomes `SpecPatch`.
- Produces (API): `ServersService.patch(id, { name?, spec?: SpecPatch })` with merge semantics; if the resulting spec is identical it neither increments `spec_version` nor pushes anything. Spec 400s state the field path (`mods.modrinthProjects.0: …`). **Plan 4 (Backups tab) depends on this to send only `{ spec: { backups } }`.**

- [ ] **Step 1: Tests (fail)**

`panel/packages/shared/src/spec-patch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson, formatZodError, mergeSpecPatch } from "./spec-patch.js";

describe("mergeSpecPatch", () => {
  const prev = { type: "PAPER", memory: "4G", mods: { modrinthProjects: ["a"] }, whitelist: { enabled: true, players: [] } };
  it("replaces the keys present, keeps the absent ones and deletes the nulls", () => {
    expect(mergeSpecPatch(prev, { memory: "6G", whitelist: null })).toEqual({ type: "PAPER", memory: "6G", mods: { modrinthProjects: ["a"] } });
  });
  it("does not merge nested objects: the section is replaced whole", () => {
    expect(mergeSpecPatch(prev, { mods: { urls: ["https://x/a.jar"] } }).mods).toEqual({ urls: ["https://x/a.jar"] });
  });
  it("ignora __proto__ y constructor", () => {
    const patch = JSON.parse('{"__proto__":{"type":"FORGE"},"constructor":1}') as Record<string, unknown>;
    const out = mergeSpecPatch(prev, patch);
    expect(out.type).toBe("PAPER");
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
  it("does not modify the previous object", () => {
    mergeSpecPatch(prev, { memory: "1G" });
    expect(prev.memory).toBe("4G");
  });
});

describe("canonicalJson", () => {
  it("does not depend on key order but does on array order", () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 2 }, a: 1 }));
    expect(canonicalJson({ l: [1, 2] })).not.toBe(canonicalJson({ l: [2, 1] }));
  });
});

describe("formatZodError", () => {
  it("prepends the path", () => {
    const r = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toMatch(/^a\.b: /);
  });
});
```

`panel/apps/api/src/servers/patch.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const create = async (spec: object = {}) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name: "Uno", spec: { type: "PAPER", memory: "4G", properties: { motd: "Hola" }, ...spec } } })).json();
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/servers/${id}`, headers: { cookie }, payload: payload as object });

describe("spec PATCH as a top-level merge", () => {
  it("a single section does not overwrite the rest of the spec", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { whitelist: { enabled: true, players: ["Lobo"] } } });
    expect(res.statusCode).toBe(200);
    const after = res.json();
    expect(after.specVersion).toBe(2);
    expect(after.spec).toMatchObject({ type: "PAPER", memory: "4G", properties: { motd: "Hola" }, whitelist: { enabled: true, players: ["Lobo"] } });
    expect(after.spec.ports.game).toBe(s.spec.ports.game);
    expect(after.spec.rconPassword).toBe(s.spec.rconPassword);
  });

  it("null deletes a section; the modpack type requires modpack", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await patch(s.id, { spec: { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "" });
    res = await patch(s.id, { spec: { type: "PAPER", modpack: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).not.toHaveProperty("modpack");
    expect(res.json().specVersion).toBe(3);
  });

  it("resending the same spec does not increment the version; with a new name it only renames", async () => {
    const s = await create();
    const { rconPassword: _r, ...same } = s.spec;
    let res = await patch(s.id, { spec: same });
    expect(res.json().specVersion).toBe(1);
    res = await patch(s.id, { name: "Otro nombre", spec: same });
    expect(res.json()).toMatchObject({ name: "Otro nombre", specVersion: 1 });
  });

  it("rconPassword cannot be changed by PATCH", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { rconPassword: "hackhackhack" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.rconPassword).toBe(s.spec.rconPassword);
    expect(res.json().specVersion).toBe(1);
  });

  it("ports without game keeps the game port", async () => {
    const s = await create();
    const res = await patch(s.id, { spec: { ports: { extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().spec.ports).toEqual({ game: s.spec.ports.game, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] });
  });

  it("errors with the field path and invalid bodies", async () => {
    const s = await create();
    let res = await patch(s.id, { spec: { mods: { modrinthProjects: ["con espacio"] } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^mods\.modrinthProjects\.0: /);
    res = await patch(s.id, { spec: "x" });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: "PATCH", url: `/api/servers/${s.id}`, headers: { cookie, "content-type": "application/json" }, payload: '{"spec":{"__proto__":{"type":"FORGE"}}}' });
    expect(res.statusCode).toBe(400);
    expect(app.servers.get(s.id)!.spec_version).toBe(1);
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/shared test; pnpm --filter @mcsm/api exec vitest run src/servers/patch.test.ts
```
Expected: FAIL (`Cannot find module './spec-patch.js'`; in the API, "a single section does not overwrite the rest of the spec" fails because today PATCH replaces the whole spec and `memory` goes back to `2G`).

- [ ] **Step 3: Implementation**

`panel/packages/shared/src/spec-patch.ts`:
```ts
import { z } from "zod";

/**
 * Spec PATCH: top-level merge (RFC 7386 only at the root).
 * - key present → replaces the previous value entirely (nested objects are not merged);
 * - key with `null` → deleted (reverts to its default value or to "no section");
 * - key absent → what was there is kept.
 * This way each screen (configuration form, Backups tab of Plan 4…) sends only
 * the sections it edits without overwriting the others.
 */
export const specPatchSchema = z.record(z.string(), z.unknown());
export type SpecPatch = z.infer<typeof specPatchSchema>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mergeSpecPatch(previous: Record<string, unknown>, patch: SpecPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** JSON with sorted keys: compares specs without depending on insertion order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

/** First zod error with the field path in front ("modpack.slugOrUrl: …"). */
export function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid spec";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
```

In `panel/packages/shared/src/spec.ts` (outside the anchor): import `import { specPatchSchema } from "./spec-patch.js";` alongside the other imports and replace `serverPatchSchema` with:
```ts
export const serverPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  /** Top-level merge over the saved spec (see mergeSpecPatch). */
  spec: specPatchSchema.optional(),
});
```

In `panel/packages/shared/src/index.ts` add `export * from "./spec-patch.js";`.

In `panel/apps/api/src/servers/service.ts`:

1. Replace the `@mcsm/shared` import with:
```ts
import {
  canonicalJson, formatZodError, mergeSpecPatch, specInputSchema, specSchema, slugify,
  type ServerCreateInput, type Spec, type SpecInput, type SpecPatch, type PowerActionName,
} from "@mcsm/shared";
```

2. In `completeSpec`, the validation error uses the field path:
```ts
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
```

3. Replace the whole `patch` method with:
```ts
  /** `input.spec` is a top-level merge over the saved spec (see mergeSpecPatch). */
  async patch(id: string, input: { name?: string; spec?: SpecPatch }) {
    const row = this.requireServer(id);
    let updated = row;
    let spec: Spec | null = null;
    if (input.spec) {
      const previous = JSON.parse(row.spec) as Spec;
      const { rconPassword: _secret, ...previousInput } = previous;
      const merged = specInputSchema.safeParse(mergeSpecPatch(previousInput, input.spec));
      if (!merged.success) throw new HttpError(400, formatZodError(merged.error));
      const candidate = this.completeSpec(row.node_id, merged.data, previous);
      // Without real changes it is not versioned: the agent would have nothing to apply.
      if (canonicalJson(candidate) !== canonicalJson(previous)) spec = candidate;
    }
    if (spec) {
      this.checkPorts(row.node_id, spec, row.id);
      updated = this.app.servers.updateSpec(id, spec, input.name);
      void this.push(updated);
    } else if (input.name && input.name !== row.name) {
      updated = this.app.servers.rename(id, input.name); // no spec change: not versioned
    }
    return toServerDto(updated, { includeSecrets: true });
  }
```
(`rconPassword` never enters the merge: `completeSpec` always keeps the previous one; `ports` without `game` keeps the game port.)

- [ ] **Step 4: Run (must pass)**

```bash
pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS. The Plan 1 tests in `servers.test.ts` stay green (the PATCH `{ name, spec: { memory: "3G" } }` produces version 2 with memory 3G). The Plan 1 web form, which still sends the whole spec, keeps working (a merge with all keys is equivalent to replacing).

- [ ] **Step 5: Commit**

```bash
git add panel/packages/shared/src/ panel/apps/api/src/servers/
git commit -m "feat(api): spec PATCH as a top-level merge, without versioning empty changes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Panel — global CurseForge API key

**Agent:** panel-api-dev (review also with `security-auditor`: it handles a secret)

**Files:**
- Create: `panel/apps/api/src/curseforge/repo.ts`, `panel/apps/api/src/curseforge/routes.ts`, `panel/apps/api/src/curseforge/curseforge.test.ts`
- Modify: `panel/apps/api/src/servers/repo.ts` (`toServerSpecMessage`, `bumpVersion`), `panel/apps/api/src/servers/service.ts` (`push`, `reapplyCurseForge`), `panel/apps/api/src/agents/service.ts` (one line of the handshake, outside the anchor), `panel/apps/api/src/app.ts` (below the anchor), `panel/apps/api/src/db/migrations.ts` (below the anchor)

**Interfaces:**
- Consumes: `usesCurseForge`, `formatZodError` (`@mcsm/shared`, Tasks 2–3); `ServersService`, `ServersRepo`, `AgentService.handshake` (Plan 1); `settings(key, value)` table.
- Produces: `CurseForgeKeyRepo` decorated as `app.curseforge` with `get(): string | null` and `set(apiKey: string): boolean` (true if it changed; `""` deletes); constant `CURSEFORGE_KEY_SETTING = "curseforge_api_key"`; `GET /api/settings/curseforge` and `PUT /api/settings/curseforge {apiKey}` → `{ configured: boolean }` (never the key); `toServerSpecMessage(row, { curseforgeApiKey?: string | null })`; `ServersRepo.bumpVersion(id): ServerRow`; `ServersService.reapplyCurseForge(): number`; migration `020_cf_api_key_env_to_settings`. **Plan 9 (Settings page) reuses these endpoints; any new call to `toServerSpecMessage` (Plans 6–7) must pass `{ curseforgeApiKey: app.curseforge.get() }`.**

- [ ] **Step 1: Test (fails)**

`panel/apps/api/src/curseforge/curseforge.test.ts`:
```ts
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Envelope } from "@mcsm/proto";
import { buildApp } from "../app.js";
import { migrate, openDb } from "../db/db.js";
import { migrations } from "../db/migrations.js";
import { FakeAgent } from "../../test/fake-agent.js";

const KEY = "$2a$10$abcdefghijklmnopqrstuv";

let app: FastifyInstance; let url: string; let cookie: string; let nodeId: string; let nodeToken: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId, nodeToken } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const putKey = (apiKey: string) => app.inject({ method: "PUT", url: "/api/settings/curseforge", headers: { cookie }, payload: { apiKey } });
const createServer = async (name: string, spec: object) =>
  (await app.inject({ method: "POST", url: "/api/servers", headers: { cookie }, payload: { nodeId, name, spec } })).json();
const cfSpec = { type: "AUTO_CURSEFORGE", modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-10" } };
const specOf = (env: Envelope) => {
  if (env.body.case !== "applySpec") throw new Error(`expected applySpec, got ${env.body.case}`);
  return { version: env.body.value.server!.version, serverId: env.body.value.server!.serverId, spec: JSON.parse(new TextDecoder().decode(env.body.value.server!.specJson)) };
};

describe("CurseForge API key", () => {
  it("GET/PUT never return the key; validates the format", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } })).json()).toEqual({ configured: false });
    let res = await putKey(KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true });
    res = await app.inject({ method: "GET", url: "/api/settings/curseforge", headers: { cookie } });
    expect(res.json()).toEqual({ configured: true });
    expect(res.body).not.toContain(KEY);
    expect((await putKey("con espacio")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/settings/curseforge" })).statusCode).toBe(401);
    expect((await putKey("")).json()).toEqual({ configured: false });
  });

  it("only goes to the agent in specs that use CurseForge and never to the browser", async () => {
    await putKey(KEY);
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const cfP = createServer("Pack", cfSpec);
    const a1 = await agent.waitFor("applySpec");
    agent.ack(a1.id);
    const cf = await cfP;
    expect(specOf(a1).spec.curseforgeApiKey).toBe(KEY);

    const paperP = createServer("Paper", { type: "PAPER" });
    const a2 = await agent.waitFor("applySpec");
    agent.ack(a2.id);
    await paperP;
    expect(specOf(a2).spec).not.toHaveProperty("curseforgeApiKey");

    for (const u of ["/api/servers", `/api/servers/${cf.id}`]) {
      const body = (await app.inject({ method: "GET", url: u, headers: { cookie } })).body;
      expect(body).not.toContain(KEY);
      expect(body).not.toContain("curseforgeApiKey");
    }
    expect(app.servers.get(cf.id)!.spec).not.toContain(KEY);
    agent.close();
  });

  it("changing the key reapplies only CurseForge servers; the same key does nothing", async () => {
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER", mods: { curseforgeFiles: [] } });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect({ specVersions: { [cf.id]: 1n, [paper.id]: 1n } });
    await agent.waitFor("helloAck");
    agent.ack((await agent.waitFor("syncSpecs")).id);

    const put = putKey(KEY);
    const apply = specOf(await agent.waitFor("applySpec"));
    expect(apply).toMatchObject({ serverId: cf.id, version: 2n });
    expect(apply.spec.curseforgeApiKey).toBe(KEY);
    expect((await put).statusCode).toBe(200);
    expect(app.servers.get(paper.id)!.spec_version).toBe(1);

    await putKey(KEY);
    expect(app.servers.get(cf.id)!.spec_version).toBe(2);

    const clear = putKey("");
    const cleared = specOf(await agent.waitFor("applySpec"));
    expect(cleared.version).toBe(3n);
    expect(cleared.spec).not.toHaveProperty("curseforgeApiKey");
    await clear;
    agent.close();
  });

  it("SyncSpecs after Hello includes the key in CurseForge servers", async () => {
    await putKey(KEY);
    const cf = await createServer("Pack", cfSpec);
    const paper = await createServer("Paper", { type: "PAPER" });
    const agent = new FakeAgent(url, nodeToken);
    await agent.connect();
    await agent.waitFor("helloAck");
    const sync = await agent.waitFor("syncSpecs");
    if (sync.body.case !== "syncSpecs") throw new Error();
    const byId = Object.fromEntries(sync.body.value.servers.map((s) => [s.serverId, JSON.parse(new TextDecoder().decode(s.specJson))]));
    expect(byId[cf.id].curseforgeApiKey).toBe(KEY);
    expect(byId[paper.id]).not.toHaveProperty("curseforgeApiKey");
    agent.ack(sync.id);
    agent.close();
  });
});

describe("migration 020_cf_api_key_env_to_settings", () => {
  it("moves CF_API_KEY from the free env to Settings and versions the spec", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const idx = migrations.findIndex((m) => m.name === "020_cf_api_key_env_to_settings");
    expect(idx).toBeGreaterThan(0);
    for (const m of migrations.slice(0, idx)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, "t");
    }
    db.prepare("INSERT INTO nodes (id, name, token_hash, created_at) VALUES ('n', 'nas', 'h', 't')").run();
    const withKey = JSON.stringify({ type: "PAPER", env: { CF_API_KEY: KEY, USE_AIKAR_FLAGS: "true" } });
    const without = JSON.stringify({ type: "PAPER", env: { USE_AIKAR_FLAGS: "true" } });
    const ins = db.prepare("INSERT INTO servers (id, node_id, name, slug, spec, spec_version, created_at, updated_at) VALUES (?, 'n', ?, ?, ?, 4, ?, 't')");
    ins.run("a", "A", "a", withKey, "2026-01-01");
    ins.run("b", "B", "b", without, "2026-01-02");
    migrate(db);
    const rows = db.prepare("SELECT id, spec, spec_version FROM servers ORDER BY id").all() as { id: string; spec: string; spec_version: number }[];
    expect(JSON.parse(rows[0]!.spec).env).toEqual({ USE_AIKAR_FLAGS: "true" });
    expect(rows[0]!.spec_version).toBe(5);
    expect(rows[1]!.spec_version).toBe(4);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'curseforge_api_key'").get()).toEqual({ value: KEY });
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/api exec vitest run src/curseforge/curseforge.test.ts
```
Expected: FAIL (`/api/settings/curseforge` answers 404; `migrations.findIndex(...)` is -1).

- [ ] **Step 3: Repository and routes**

`panel/apps/api/src/curseforge/repo.ts`:
```ts
import type { Db } from "../db/db.js";

/** Key in the settings table where the global CurseForge API key lives (spec §4 settings). */
export const CURSEFORGE_KEY_SETTING = "curseforge_api_key";

/**
 * Global CurseForge API key. It is stored in plain text (it must be sent to the agents), is never
 * returned by the API, and is never copied to servers.spec: it is added to the spec only in the
 * message to the agent (toServerSpecMessage) and only if the spec uses CurseForge.
 */
export class CurseForgeKeyRepo {
  constructor(private db: Db) {}

  get(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CURSEFORGE_KEY_SETTING) as { value: string } | undefined;
    return row?.value || null;
  }

  /** Saves the key (`""` deletes it). Returns true if the value changed. */
  set(apiKey: string): boolean {
    if ((this.get() ?? "") === apiKey) return false;
    if (apiKey === "") this.db.prepare("DELETE FROM settings WHERE key = ?").run(CURSEFORGE_KEY_SETTING);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CURSEFORGE_KEY_SETTING, apiKey);
    return true;
  }
}

declare module "fastify" {
  interface FastifyInstance { curseforge: CurseForgeKeyRepo }
}
```

`panel/apps/api/src/curseforge/routes.ts`:
```ts
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { formatZodError } from "@mcsm/shared";

const bodySchema = z.object({
  apiKey: z.string().trim().max(200, "The API key is too long").regex(/^\S*$/, "The API key cannot contain spaces"),
});

/** GET/PUT of the global CurseForge API key. Never returns the key, only whether it is configured. */
export async function curseforgeRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal error" });
  });

  app.get("/api/settings/curseforge", async () => ({ configured: app.curseforge.get() !== null }));

  app.put("/api/settings/curseforge", async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: formatZodError(body.error) });
    if (app.curseforge.set(body.data.apiKey)) {
      // Servers that use CurseForge must be recreated with the new key (or without it).
      app.serversService.reapplyCurseForge();
    }
    return { configured: app.curseforge.get() !== null };
  });
}
```

- [ ] **Step 4: The key only in the message to the agent**

In `panel/apps/api/src/servers/repo.ts`, change the `@mcsm/shared` import to `import { usesCurseForge, type Spec } from "@mcsm/shared";`, replace `toServerSpecMessage` with:
```ts
/**
 * ServerSpec message for the agent. The global CurseForge API key is added here, only to specs that
 * use CurseForge: it is not in servers.spec nor in the browser DTOs.
 */
export function toServerSpecMessage(r: ServerRow, opts: { curseforgeApiKey?: string | null } = {}): ServerSpec {
  let json = r.spec;
  if (opts.curseforgeApiKey) {
    const spec = JSON.parse(r.spec) as Spec;
    if (usesCurseForge(spec)) json = JSON.stringify({ ...spec, curseforgeApiKey: opts.curseforgeApiKey });
  }
  return create(ServerSpecSchema, {
    serverId: r.id, slug: r.slug, version: BigInt(r.spec_version),
    desiredState: r.desired_state === "running" ? DesiredState.RUNNING : DesiredState.STOPPED,
    specJson: new TextEncoder().encode(json),
  });
}
```
and add to `ServersRepo`, before `setDesiredState`:
```ts
  /** New version with the same spec (e.g. the CurseForge API key changed): the agent reapplies it. */
  bumpVersion(id: string): ServerRow {
    this.db.prepare("UPDATE servers SET spec_version = spec_version + 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
    return this.get(id)!;
  }
```

In `panel/apps/api/src/servers/service.ts`: add `usesCurseForge` to the `@mcsm/shared` import; in `push` send the key:
```ts
      await conn.request({ case: "applySpec", value: { server: toServerSpecMessage(row, { curseforgeApiKey: this.app.curseforge.get() }) } }, 120_000);
```
and add before `create`:
```ts
  /** Reapplies (version +1, same spec) the servers that use CurseForge. Returns how many. */
  reapplyCurseForge(): number {
    let n = 0;
    for (const row of this.app.servers.list()) {
      if (!usesCurseForge(JSON.parse(row.spec) as Spec)) continue;
      void this.push(this.app.servers.bumpVersion(row.id));
      n++;
    }
    return n;
  }
```

In `panel/apps/api/src/agents/service.ts` (outside the anchor), in `handshake`, replace the line that builds `servers` with:
```ts
    const curseforgeApiKey = this.app.curseforge.get();
    const servers = rows
      .filter((r) => hello.specVersions[r.id] !== BigInt(r.spec_version))
      .map((r) => toServerSpecMessage(r, { curseforgeApiKey }));
```
(With the new signature, `.map(toServerSpecMessage)` no longer compiles: `map` would pass the index as the second argument.)

- [ ] **Step 5: Wiring and migration**

In `panel/apps/api/src/app.ts`, imports alongside the others:
```ts
import { CurseForgeKeyRepo } from "./curseforge/repo.js";
import { curseforgeRoutes } from "./curseforge/routes.js";
```
and in `buildApp`, below the anchor `// ── plan-3 ──` (after `serverRoutes`):
```ts
  // ── plan-3 ──
  app.decorate("curseforge", new CurseForgeKeyRepo(opts.db));
  await app.register(curseforgeRoutes);
```

In `panel/apps/api/src/db/migrations.ts`, below the anchor `// ── plan-3 ──` of the array:
```ts
  {
    // CF_API_KEY becomes reserved: the key someone had put in a server's free env
    // is moved to Settings (if there was none already) and removed from the spec (version +1).
    name: "020_cf_api_key_env_to_settings",
    sql: `
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'curseforge_api_key', json_extract(spec, '$.env.CF_API_KEY') FROM servers
  WHERE json_type(spec, '$.env.CF_API_KEY') = 'text' AND json_extract(spec, '$.env.CF_API_KEY') <> ''
  ORDER BY created_at LIMIT 1;
UPDATE servers
  SET spec = json_remove(spec, '$.env.CF_API_KEY'),
      spec_version = spec_version + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE json_type(spec, '$.env.CF_API_KEY') IS NOT NULL;
`,
  },
```

- [ ] **Step 6: Run (must pass)**

```bash
pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS (`curseforge.test.ts` 5 tests and the rest of the API unchanged).

- [ ] **Step 7: Commit**

```bash
git add panel/apps/api/src/
git commit -m "feat(api): global CurseForge API key, only sent to the agent in specs that use it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Panel — templates (table, CRUD, save as, duplicate, create server)

**Agent:** panel-api-dev

**Files:**
- Create: `panel/packages/shared/src/templates.ts`, `panel/packages/shared/src/templates.test.ts`, `panel/apps/api/src/templates/repo.ts`, `panel/apps/api/src/templates/routes.ts`, `panel/apps/api/src/templates/templates.test.ts`
- Modify: `panel/packages/shared/src/spec.ts` (`templateSpecSchema` at the end of the file, `plan-3` block), `panel/packages/shared/src/index.ts`, `panel/apps/api/src/app.ts` (below the anchor), `panel/apps/api/src/db/migrations.ts` (below the anchor)

**Interfaces:**
- Consumes: `baseFields`, `specChecks`, `serverCreateSchema` (`spec.ts`); `specPatchSchema`, `mergeSpecPatch`, `formatZodError` (Task 3); `ServersService.create`, `HttpError` (`servers/service.ts`); `app.servers`.
- Produces (`@mcsm/shared`): `templateSpecSchema`, `type TemplateSpec`, `templateCreateSchema` (`{name, description, spec? | fromServerId?}`), `templatePatchSchema`, `templateInstantiateSchema` (`{nodeId, name, slug?, port?, desiredState}`), `specToTemplate(spec)`, `copyName(name, n)`.
- Produces (API): table `templates` (migration `021_templates`), `app.templates: TemplatesRepo`, `TemplateDto {id, name, description, spec: TemplateSpec, sourceServerId, createdAt, updatedAt}` and the routes: `GET /api/templates`, `GET /api/templates/:id`, `POST /api/templates` (201), `PATCH /api/templates/:id` (spec with merge), `POST /api/templates/:id/duplicate` (201), `DELETE /api/templates/:id` (204), `POST /api/templates/:id/servers` (201, returns the `ServerDto` with secrets, like `POST /api/servers`).

- [ ] **Step 1: Tests (fail)**

`panel/packages/shared/src/templates.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyName, specToTemplate, templateCreateSchema, templateInstantiateSchema } from "./templates.js";
import { specInputSchema, templateSpecSchema } from "./spec.js";

const modded = JSON.parse(readFileSync(new URL("../../../../proto/fixtures/spec-modded.json", import.meta.url), "utf8"));

describe("templates", () => {
  it("specToTemplate removes ports, rconPassword and the CurseForge key and keeps the rest", () => {
    const t = specToTemplate({ ...modded, curseforgeApiKey: "k" });
    expect(t).not.toHaveProperty("ports");
    expect(t).not.toHaveProperty("rconPassword");
    expect(t).not.toHaveProperty("curseforgeApiKey");
    const { ports: _p, rconPassword: _r, ...rest } = modded;
    expect(t).toEqual(rest);
  });
  it("a template is instantiated as a valid SpecInput by adding only ports", () => {
    const t = specToTemplate(modded);
    expect(specInputSchema.parse({ ...t, ports: { extra: [] } }).ports.game).toBeUndefined();
  });
  it("the template applies the same validations as the spec", () => {
    expect(templateSpecSchema.safeParse({ type: "MODRINTH" }).success).toBe(false);
    expect(templateSpecSchema.safeParse({ env: { CF_API_KEY: "x" } }).success).toBe(false);
  });
  it("create requires a spec or a source server, not both", () => {
    expect(templateCreateSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "A", spec: {}, fromServerId: "x" }).success).toBe(false);
    expect(templateCreateSchema.parse({ name: " A ", spec: {} })).toEqual({ name: "A", description: "", spec: {} });
  });
  it("instantiating validates port and slug", () => {
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", port: 70000 }).success).toBe(false);
    expect(templateInstantiateSchema.safeParse({ nodeId: "n", name: "X", slug: "Mal Slug" }).success).toBe(false);
    expect(templateInstantiateSchema.parse({ nodeId: "n", name: "X" }).desiredState).toBe("stopped");
  });
  it("copyName", () => {
    expect(copyName("Survival", 1)).toBe("Survival (copy)");
    expect(copyName("Survival", 3)).toBe("Survival (copy 3)");
    expect(copyName("x".repeat(60), 2)).toHaveLength(60);
  });
});
```

`panel/apps/api/src/templates/templates.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { openDb } from "../db/db.js";

let app: FastifyInstance; let cookie: string; let nodeId: string;

beforeEach(async () => {
  app = await buildApp({ db: openDb(":memory:") });
  const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
  const c = res.cookies.find((c) => c.name === "mcsm_session")!;
  cookie = `${c.name}=${c.value}`;
  const t = (await app.inject({ method: "POST", url: "/api/nodes/enrollment-tokens", headers: { cookie }, payload: { nameHint: "nas" } })).json().token;
  ({ nodeId } = (await app.inject({ method: "POST", url: "/agent/enroll", payload: { enrollToken: t, nameHint: "nas", agentVersion: "fake" } })).json());
});
afterEach(async () => { await app.close(); });

const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const fullSpec = {
  type: "FABRIC", version: "1.21.4", imageTag: "java21", memory: "3G",
  mods: { modrinthProjects: ["lithium", "fabric-api"] },
  properties: { motd: "Plantilla", difficulty: "hard" },
  whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"],
  env: { USE_AIKAR_FLAGS: "true" }, resources: { cpus: 2, memLimit: "4G" }, restartPolicy: "always",
  ports: { game: 25580, extra: [{ host: 24454, container: 24454, proto: "udp", label: "Voice" }] },
};

describe("templates", () => {
  it("save as template removes ports and rconPassword; instantiating reproduces the server except name, ports and RCON", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Original", spec: fullSpec })).json();
    let res = await req("POST", "/api/templates", { name: "Fabric optimizado", description: "Con lithium", fromServerId: server.id });
    expect(res.statusCode).toBe(201);
    const tpl = res.json();
    expect(tpl).toMatchObject({ name: "Fabric optimizado", description: "Con lithium", sourceServerId: server.id });
    expect(tpl.spec).not.toHaveProperty("ports");
    expect(tpl.spec).not.toHaveProperty("rconPassword");
    expect(JSON.stringify(tpl)).not.toContain(server.spec.rconPassword);

    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "Copia" });
    expect(res.statusCode).toBe(201);
    const copy = res.json();
    expect(copy.name).toBe("Copia");
    expect(copy.slug).toBe("copia");
    expect(copy.spec.ports).toEqual({ game: 25565, extra: [] });
    expect(copy.spec.rconPassword).toHaveLength(43);
    expect(copy.spec.rconPassword).not.toBe(server.spec.rconPassword);
    const strip = (s: Record<string, unknown>) => { const { ports: _p, rconPassword: _r, ...rest } = s; return rest; };
    expect(strip(copy.spec)).toEqual(strip(server.spec));
  });

  it("instantiating with an explicit port; a busy port gives 409", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Vanilla", spec: { type: "VANILLA" } })).json();
    let res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "A", port: 25590, desiredState: "running" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ desiredState: "running", spec: { ports: { game: 25590 } } });
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId, name: "B", port: 25590 });
    expect(res.statusCode).toBe(409);
    res = await req("POST", `/api/templates/${tpl.id}/servers`, { nodeId: "no-existe", name: "C" });
    expect(res.statusCode).toBe(404);
  });

  it("creating from spec discards ports and rconPassword and validates like a server", async () => {
    let res = await req("POST", "/api/templates", { name: "Con puertos", spec: { ...fullSpec, rconPassword: "secretosecreto" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().spec).not.toHaveProperty("ports");
    expect(res.json().spec).not.toHaveProperty("rconPassword");
    res = await req("POST", "/api/templates", { name: "Mala", spec: { type: "MODRINTH" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/modpack/);
    res = await req("POST", "/api/templates", { name: "Nada" });
    expect(res.statusCode).toBe(400);
  });

  it("unique names, PATCH with merge, duplicate and delete", async () => {
    const tpl = (await req("POST", "/api/templates", { name: "Base", spec: { type: "PAPER", memory: "4G" } })).json();
    expect((await req("POST", "/api/templates", { name: "Base", spec: {} })).statusCode).toBe(409);

    let res = await req("PATCH", `/api/templates/${tpl.id}`, { description: "Nueva", spec: { ops: ["Lobo"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Base", description: "Nueva", spec: { type: "PAPER", memory: "4G", ops: ["Lobo"] } });
    res = await req("PATCH", `/api/templates/${tpl.id}`, { spec: { ops: null } });
    expect(res.json().spec).not.toHaveProperty("ops");

    const d1 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    const d2 = (await req("POST", `/api/templates/${tpl.id}/duplicate`)).json();
    expect([d1.name, d2.name]).toEqual(["Base (copy)", "Base (copy 2)"]);
    expect(d1.spec).toEqual(res.json().spec);
    expect((await req("PATCH", `/api/templates/${d1.id}`, { name: "Base" })).statusCode).toBe(409);

    expect((await req("GET", "/api/templates")).json().map((t: { name: string }) => t.name)).toEqual(["Base", "Base (copy 2)", "Base (copy)"]); // sorted by name (NOCASE)
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(204);
    expect((await req("DELETE", `/api/templates/${d2.id}`)).statusCode).toBe(404);
    expect((await req("GET", `/api/templates/${d2.id}`)).statusCode).toBe(404);
  });

  it("deleting the source server leaves the template with sourceServerId null", async () => {
    const server = (await req("POST", "/api/servers", { nodeId, name: "Origen" })).json();
    const tpl = (await req("POST", "/api/templates", { name: "De origen", fromServerId: server.id })).json();
    expect((await req("DELETE", `/api/servers/${server.id}`)).statusCode).toBe(204);
    expect((await req("GET", `/api/templates/${tpl.id}`)).json().sourceServerId).toBeNull();
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/templates" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/shared test; pnpm --filter @mcsm/api exec vitest run src/templates/templates.test.ts
```
Expected: FAIL (`Cannot find module './templates.js'`; in the API, `/api/templates` answers 404).

- [ ] **Step 3: Shared schemas**

At the end of `panel/packages/shared/src/spec.ts`:
```ts
// ── plan-3 ── templates
/**
 * Template spec (spec §4 templates): the server spec without `ports` or `rconPassword`. When
 * parsing, zod drops those keys (and any other unknown one), so saving a server spec as a
 * template never carries ports or secrets.
 */
export const templateSpecSchema = z.object({ ...baseFields }).superRefine(specChecks);
export type TemplateSpec = z.infer<typeof templateSpecSchema>;
```
(Don't use `.omit()`: zod 4 throws “.omit() cannot be used on object schemas containing refinements”.)

`panel/packages/shared/src/templates.ts`:
```ts
import { z } from "zod";
import { templateSpecSchema, type TemplateSpec } from "./spec.js";
import { specPatchSchema } from "./spec-patch.js";

const templateName = z.string().trim().min(1, "The name is required").max(60, "Maximum 60 characters");
const templateDescription = z.string().trim().max(500, "Maximum 500 characters");

/** Create template: from a spec (template editor) or from a server ("Save as template"). */
export const templateCreateSchema = z
  .object({
    name: templateName,
    description: templateDescription.default(""),
    spec: specPatchSchema.optional(),
    fromServerId: z.string().min(1).optional(),
  })
  .refine((t) => (t.spec === undefined) !== (t.fromServerId === undefined), { message: "Provide a spec or a source server (only one)" });
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;

/** Template PATCH: `spec` with the same merge semantics as the server PATCH. */
export const templatePatchSchema = z.object({
  name: templateName.optional(),
  description: templateDescription.optional(),
  spec: specPatchSchema.optional(),
});

/** Create a server from a template: the panel fills in the port (if not given) and rconPassword. */
export const templateInstantiateSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  desiredState: z.enum(["running", "stopped"]).default("stopped"),
});
export type TemplateInstantiateInput = z.infer<typeof templateInstantiateSchema>;

/** Removes ports, rconPassword and any key not belonging to the template. Throws ZodError if it does not validate. */
export function specToTemplate(spec: Record<string, unknown>): TemplateSpec {
  return templateSpecSchema.parse(spec);
}

/** "Name (copy)", "Name (copy 2)"… without exceeding 60 characters. */
export function copyName(name: string, n: number): string {
  const suffix = n <= 1 ? " (copy)" : ` (copy ${n})`;
  return name.slice(0, 60 - suffix.length).trimEnd() + suffix;
}
```

In `panel/packages/shared/src/index.ts` add `export * from "./templates.js";`.

- [ ] **Step 4: Repository, routes and migration

`panel/apps/api/src/templates/repo.ts`:
```ts
import type { TemplateSpec } from "@mcsm/shared";
import type { Db } from "../db/db.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export interface TemplateRow {
  id: string; name: string; description: string; spec: string; source_server_id: string | null;
  created_at: string; updated_at: string;
}

export interface TemplateDto {
  id: string; name: string; description: string; spec: TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}

export function toTemplateDto(r: TemplateRow): TemplateDto {
  return {
    id: r.id, name: r.name, description: r.description, spec: JSON.parse(r.spec) as TemplateSpec,
    sourceServerId: r.source_server_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class TemplatesRepo {
  constructor(private db: Db) {}

  list(): TemplateRow[] {
    return this.db.prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE").all() as unknown as TemplateRow[];
  }
  get(id: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined) ?? null;
  }
  getByName(name: string): TemplateRow | null {
    return (this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | undefined) ?? null;
  }
  create(input: { name: string; description: string; spec: TemplateSpec; sourceServerId: string | null }): TemplateRow {
    const id = newId();
    const now = nowIso();
    this.db.prepare(`INSERT INTO templates (id, name, description, spec, source_server_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.description, JSON.stringify(input.spec), input.sourceServerId, now, now);
    return this.get(id)!;
  }
  update(id: string, input: { name: string; description: string; spec: TemplateSpec }): TemplateRow {
    this.db.prepare("UPDATE templates SET name = ?, description = ?, spec = ?, updated_at = ? WHERE id = ?")
      .run(input.name, input.description, JSON.stringify(input.spec), nowIso(), id);
    return this.get(id)!;
  }
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes === 1;
  }
}

declare module "fastify" {
  interface FastifyInstance { templates: TemplatesRepo }
}
```

`panel/apps/api/src/templates/routes.ts`:
```ts
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import {
  copyName, formatZodError, mergeSpecPatch, serverCreateSchema, specToTemplate, templateCreateSchema,
  templateInstantiateSchema, templatePatchSchema, type Spec, type TemplateSpec,
} from "@mcsm/shared";
import { HttpError } from "../servers/service.js";
import { toTemplateDto, type TemplateRow } from "./repo.js";

/** Validates a template spec; errors come out as 400 with the field path. */
function toTemplateSpec(raw: Record<string, unknown>): TemplateSpec {
  try {
    return specToTemplate(raw);
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, formatZodError(e));
    throw e;
  }
}

export async function templateRoutes(app: FastifyInstance) {
  const repo = app.templates;

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: formatZodError(err) });
    const status = (err as FastifyError).statusCode;
    if (status === undefined || status >= 500) {
      app.log.error(err);
      return reply.code(500).send({ error: "Internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  const requireTemplate = (id: string): TemplateRow => {
    const row = repo.get(id);
    if (!row) throw new HttpError(404, "Template not found");
    return row;
  };
  const ensureFreeName = (name: string, selfId?: string) => {
    const other = repo.getByName(name);
    if (other && other.id !== selfId) throw new HttpError(409, `A template named “${name}” already exists`);
  };

  app.get("/api/templates", async () => repo.list().map(toTemplateDto));

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (req) => toTemplateDto(requireTemplate(req.params.id)));

  app.post("/api/templates", async (req, reply) => {
    const input = templateCreateSchema.parse(req.body);
    ensureFreeName(input.name);
    let spec: TemplateSpec;
    let sourceServerId: string | null = null;
    if (input.fromServerId) {
      const server = app.servers.get(input.fromServerId);
      if (!server) throw new HttpError(404, "Server not found");
      spec = toTemplateSpec(JSON.parse(server.spec) as Spec);
      sourceServerId = server.id;
    } else {
      spec = toTemplateSpec(input.spec ?? {});
    }
    const row = repo.create({ name: input.name, description: input.description, spec, sourceServerId });
    return reply.code(201).send(toTemplateDto(row));
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    const row = requireTemplate(req.params.id);
    const input = templatePatchSchema.parse(req.body);
    const name = input.name ?? row.name;
    ensureFreeName(name, row.id);
    const spec = input.spec ? toTemplateSpec(mergeSpecPatch(JSON.parse(row.spec) as Record<string, unknown>, input.spec)) : (JSON.parse(row.spec) as TemplateSpec);
    return toTemplateDto(repo.update(row.id, { name, description: input.description ?? row.description, spec }));
  });

  app.post<{ Params: { id: string } }>("/api/templates/:id/duplicate", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    let n = 1;
    while (repo.getByName(copyName(row.name, n))) n++;
    const copy = repo.create({ name: copyName(row.name, n), description: row.description, spec: JSON.parse(row.spec) as TemplateSpec, sourceServerId: row.source_server_id });
    return reply.code(201).send(toTemplateDto(copy));
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (req, reply) => {
    if (!repo.delete(req.params.id)) throw new HttpError(404, "Template not found");
    return reply.code(204).send();
  });

  /** Creates a server identical to the template except name, ports and rconPassword (the panel sets those). */
  app.post<{ Params: { id: string } }>("/api/templates/:id/servers", async (req, reply) => {
    const row = requireTemplate(req.params.id);
    const input = templateInstantiateSchema.parse(req.body);
    const spec = JSON.parse(row.spec) as TemplateSpec;
    const parsed = serverCreateSchema.safeParse({
      nodeId: input.nodeId, name: input.name, slug: input.slug, desiredState: input.desiredState,
      spec: { ...spec, ports: input.port ? { game: input.port, extra: [] } : { extra: [] } },
    });
    if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error));
    return reply.code(201).send(await app.serversService.create(parsed.data));
  });
}
```

In `panel/apps/api/src/app.ts`, imports alongside the others:
```ts
import { TemplatesRepo } from "./templates/repo.js";
import { templateRoutes } from "./templates/routes.js";
```
and in the `plan-3` block of `buildApp`, after the Task 4 code (the decorator **before** registering the routes, which read it when registered):
```ts
  app.decorate("templates", new TemplatesRepo(opts.db));
  await app.register(templateRoutes);
```

In `panel/apps/api/src/db/migrations.ts`, in the `plan-3` block, after `020_cf_api_key_env_to_settings`:
```ts
  {
    name: "021_templates",
    sql: `
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL,
  source_server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
```

- [ ] **Step 5: Run (must pass)**

```bash
pnpm --filter @mcsm/shared test && pnpm --filter @mcsm/api test && pnpm typecheck
```
Expected: PASS. The test “instantiating reproduces the server except name, ports and RCON” compares the copy's full spec with the original's, removing only `ports` and `rconPassword`.

- [ ] **Step 6: Commit**

```bash
git add panel/packages/shared/src/ panel/apps/api/src/
git commit -m "feat(api): templates with CRUD, save from a server, duplicate and create a server from a template

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web — catalogs, editable spec state, diff and API client

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/lib/spec-catalog.ts`, `panel/apps/web/src/lib/spec-edit.ts`, `panel/apps/web/src/lib/spec-edit.test.ts`, `panel/apps/web/src/lib/spec-diff.ts`, `panel/apps/web/src/lib/spec-diff.test.ts`
- Modify: `panel/apps/web/src/lib/api.ts` (`api.put`, `TemplateDto`)

**Interfaces:**
- Consumes (`@mcsm/shared`): `SpecInput`, `TemplateSpec`, `MODPACK_PLATFORMS`, `ModpackPlatform`, `canonicalJson`, `formatZodError`, `specInputSchema`, `templateSpecSchema`, `SpecPatch`, `defaultSpecInput`.
- Produces:
  - `spec-catalog.ts`: `SERVER_TYPES: {value,label,kind}[]`, `typeKind(type): "vanilla"|"plugins"|"mods"|"modpack"|"other"`, `typeLabel(type)`, `JAVA_TAGS`, `RESTART_POLICIES`, `PropDef`, `PROPERTY_DEFS` (22), `TYPED_PROPERTY_KEYS`.
  - `spec-edit.ts`: `type EditableSpec = SpecInput`, `FORM_KEYS`, `parseList`, `listToText`, `parseKv`, `kvToText`, `splitProperties`, `setProperty`, `replaceOtherProperties`, `editableSpec(spec)`, `withType(spec, type)`, `buildSpecPatch(original, edited, keys = FORM_KEYS): SpecPatch`, `validateSpec(spec, "server"|"template"): string | null`, `editableFromTemplate(TemplateSpec): EditableSpec`.
  - `spec-diff.ts`: `DiffLine {label, before, after}`, `diffSpecs(before, after): DiffLine[]`.
  - `api.ts`: `api.put<T>(path, body)`, `interface TemplateDto`.
- Note: `lib/spec-form.ts` from Plan 1 still exists until Task 10, which deletes it along with the old form.

- [ ] **Step 1: Tests (fail)**

`panel/apps/web/src/lib/spec-edit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import {
  buildSpecPatch, editableFromTemplate, editableSpec, kvToText, listToText, parseKv, parseList, replaceOtherProperties,
  setProperty, splitProperties, validateSpec, withType,
} from "./spec-edit";
import { PROPERTY_DEFS, typeKind } from "./spec-catalog";

describe("lists and key=value", () => {
  it("parseList accepts lines and commas, drops blanks and spaces", () => {
    expect(parseList(" lithium\nsodium, ferritecore:beta\n\n")).toEqual(["lithium", "sodium", "ferritecore:beta"]);
    expect(listToText(["a", "b"])).toBe("a\nb");
    expect(listToText(undefined)).toBe("");
  });
  it("parseKv ignores comments and rejects lines without =", () => {
    expect(parseKv("# hola\nmotd=Mi = servidor\n max-players = 10 ")).toEqual({ motd: "Mi = servidor", "max-players": "10" });
    expect(() => parseKv("motd")).toThrow(/key=value/);
    expect(kvToText({ a: "1", b: "2" })).toBe("a=1\nb=2");
  });
});

describe("properties", () => {
  it("splits the typed ones, sets/removes one and replaces the others", () => {
    const props = { motd: "x", "max-players": "5", "custom-x": "1" };
    expect(splitProperties(props)).toEqual({ typed: { motd: "x", "max-players": "5" }, other: { "custom-x": "1" } });
    expect(setProperty(props, "motd", "")).toEqual({ "max-players": "5", "custom-x": "1" });
    expect(setProperty(props, "pvp", "false")).toMatchObject({ pvp: "false" });
    expect(replaceOtherProperties(props, { "other-y": "2" })).toEqual({ motd: "x", "max-players": "5", "other-y": "2" });
  });
  it("the catalog has ~20 properties and known types", () => {
    expect(PROPERTY_DEFS.length).toBeGreaterThanOrEqual(20);
    expect(typeKind("FABRIC")).toBe("mods");
    expect(typeKind("AUTO_CURSEFORGE")).toBe("modpack");
    expect(typeKind("MOHIST")).toBe("other");
  });
});

describe("withType", () => {
  it("a modpack type creates the modpack section and a normal one removes it", () => {
    const base = defaultSpecInput();
    const mp = withType(base, "MODRINTH");
    expect(mp.modpack).toEqual({ platform: "MODRINTH", slugOrUrl: "", versionId: "", loader: "" });
    const cf = withType({ ...mp, modpack: { ...mp.modpack!, slugOrUrl: "pack", loader: "fabric" } }, "AUTO_CURSEFORGE");
    expect(cf.modpack).toEqual({ platform: "AUTO_CURSEFORGE", slugOrUrl: "pack", versionId: "", loader: "" });
    const paper = withType(cf, "PAPER");
    expect(paper).not.toHaveProperty("modpack");
    expect(paper.type).toBe("PAPER");
  });
});

describe("buildSpecPatch", () => {
  const original = { type: "PAPER", memory: "4G", properties: { motd: "a" }, whitelist: { enabled: true, players: ["Lobo"] }, backups: { cron: "0 4 * * *" }, rconPassword: "x" };
  it("only sends what changed and null for what was removed; never touches keys it does not edit", () => {
    const edited = { type: "PAPER", memory: "6G", properties: { motd: "a" } };
    expect(buildSpecPatch(original, edited)).toEqual({ memory: "6G", whitelist: null });
  });
  it("starting from editableSpec there are no spurious changes", () => {
    expect(buildSpecPatch(original, { ...editableSpec(original), memory: "6G" })).toEqual({ memory: "6G" });
  });
  it("key order does not count as a change", () => {
    expect(buildSpecPatch({ properties: { a: "1", b: "2" } }, { properties: { b: "2", a: "1" } })).toEqual({});
  });
});

describe("validateSpec", () => {
  it("returns the error with the field path", () => {
    expect(validateSpec(withType(defaultSpecInput(), "MODRINTH"), "server")).toMatch(/^modpack\.slugOrUrl: /);
    expect(validateSpec(defaultSpecInput(), "server")).toBeNull();
  });
  it("in templates ignores the ports", () => {
    const t = editableFromTemplate(templateSpecSchema.parse({ type: "PAPER" }));
    expect(t.ports).toEqual({ extra: [] });
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "template")).toBeNull();
    expect(validateSpec({ ...t, ports: { game: 99999, extra: [] } }, "server")).toMatch(/ports\.game/);
  });
});
```

`panel/apps/web/src/lib/spec-diff.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { diffSpecs } from "./spec-diff";

describe("diffSpecs", () => {
  const before = {
    type: "PAPER", version: "1.21.4", memory: "4G", properties: { motd: "Hola", pvp: "true" }, env: {},
    ports: { game: 25565, extra: [] }, resources: { cpus: 0, memLimit: "" }, rconPassword: "secreto",
  };
  it("no changes returns empty", () => {
    expect(diffSpecs(before, { ...before })).toEqual([]);
  });
  it("lists changes with labels and never shows rconPassword", () => {
    const after = {
      ...before, type: "FABRIC", memory: "6G", properties: { motd: "Adiós" },
      mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
      whitelist: { enabled: true, players: ["Lobo"] },
      ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
      rconPassword: "otro",
    };
    const lines = diffSpecs(before, after);
    expect(lines).toEqual(expect.arrayContaining([
      { label: "Type", before: "PAPER", after: "FABRIC" },
      { label: "Memory", before: "4G", after: "6G" },
      { label: "Property motd", before: "Hola", after: "Adiós" },
      { label: "Property pvp", before: "true", after: "—" },
      { label: "Modrinth mods", before: "—", after: "lithium" },
      { label: "Whitelist", before: "—", after: "enabled: Lobo" },
      { label: "Extra ports", before: "—", after: "19132→19132/udp (Geyser)" },
    ]));
    expect(JSON.stringify(lines)).not.toMatch(/secreto|otro/);
    expect(lines.find((l) => l.label === "CurseForge mods")).toBeUndefined();
  });
  it("readable modpack", () => {
    const lines = diffSpecs({ type: "PAPER" }, { type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric", versionId: "", loader: "fabric" } });
    expect(lines).toContainEqual({ label: "Modpack", before: "—", after: "MODRINTH: cobblemon-fabric (fabric)" });
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './spec-edit'`).

- [ ] **Step 3: Implementation**

`panel/apps/web/src/lib/spec-catalog.ts`:
```ts
/** Catalogs for the configuration form (English labels, itzg values). */

export type TypeKind = "vanilla" | "plugins" | "mods" | "modpack" | "other";

export const SERVER_TYPES: readonly { value: string; label: string; kind: TypeKind }[] = [
  { value: "VANILLA", label: "Vanilla", kind: "vanilla" },
  { value: "PAPER", label: "Paper", kind: "plugins" },
  { value: "PURPUR", label: "Purpur", kind: "plugins" },
  { value: "SPIGOT", label: "Spigot", kind: "plugins" },
  { value: "FOLIA", label: "Folia", kind: "plugins" },
  { value: "FABRIC", label: "Fabric", kind: "mods" },
  { value: "FORGE", label: "Forge", kind: "mods" },
  { value: "NEOFORGE", label: "NeoForge", kind: "mods" },
  { value: "QUILT", label: "Quilt", kind: "mods" },
  { value: "MODRINTH", label: "Modrinth modpack", kind: "modpack" },
  { value: "AUTO_CURSEFORGE", label: "CurseForge modpack", kind: "modpack" },
  { value: "FTBA", label: "FTB modpack", kind: "modpack" },
];

export function typeKind(type: string): TypeKind {
  return SERVER_TYPES.find((t) => t.value === type)?.kind ?? "other";
}

export function typeLabel(type: string): string {
  return SERVER_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const JAVA_TAGS = ["java21", "java25", "java17", "java8", "latest"] as const;

export const RESTART_POLICIES: readonly { value: "unless-stopped" | "always" | "on-failure" | "no"; label: string }[] = [
  { value: "unless-stopped", label: "Unless I stop it (unless-stopped)" },
  { value: "always", label: "Always (always)" },
  { value: "on-failure", label: "Only if it fails (on-failure)" },
  { value: "no", label: "Never (no)" },
];

export type PropKind = "text" | "int" | "bool" | "enum";
export interface PropDef { key: string; label: string; kind: PropKind; options?: readonly string[]; placeholder?: string; min?: number; max?: number }

/** The ~20 most used server.properties entries, with a typed field. The rest go in "Other". */
export const PROPERTY_DEFS: readonly PropDef[] = [
  { key: "motd", label: "MOTD (server list message)", kind: "text", placeholder: "Home server" },
  { key: "difficulty", label: "Difficulty", kind: "enum", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "gamemode", label: "Game mode", kind: "enum", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "max-players", label: "Max players", kind: "int", min: 1, max: 1000, placeholder: "20" },
  { key: "view-distance", label: "View distance (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "simulation-distance", label: "Simulation distance (chunks)", kind: "int", min: 2, max: 32, placeholder: "10" },
  { key: "pvp", label: "PvP", kind: "bool" },
  { key: "hardcore", label: "Hardcore", kind: "bool" },
  { key: "online-mode", label: "Online mode (premium accounts)", kind: "bool" },
  { key: "allow-flight", label: "Allow flight", kind: "bool" },
  { key: "allow-nether", label: "Allow the Nether", kind: "bool" },
  { key: "spawn-protection", label: "Spawn protection (blocks)", kind: "int", min: 0, max: 1000, placeholder: "16" },
  { key: "level-name", label: "World name (folder)", kind: "text", placeholder: "world" },
  { key: "level-seed", label: "Seed", kind: "text" },
  { key: "level-type", label: "World type", kind: "enum", options: ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified", "minecraft:single_biome_surface"] },
  { key: "generate-structures", label: "Generate structures", kind: "bool" },
  { key: "spawn-monsters", label: "Spawn monsters", kind: "bool" },
  { key: "enable-command-block", label: "Command blocks", kind: "bool" },
  { key: "force-gamemode", label: "Force game mode on join", kind: "bool" },
  { key: "player-idle-timeout", label: "Kick for inactivity (minutes, 0 = never)", kind: "int", min: 0, max: 10000 },
  { key: "max-world-size", label: "Max world radius (blocks)", kind: "int", min: 1, max: 29999984 },
  { key: "enforce-secure-profile", label: "Require secure profile (signed chat)", kind: "bool" },
];

export const TYPED_PROPERTY_KEYS = new Set(PROPERTY_DEFS.map((d) => d.key));
```

`panel/apps/web/src/lib/spec-edit.ts`:
```ts
import {
  MODPACK_PLATFORMS, canonicalJson, formatZodError, specInputSchema, templateSpecSchema,
  type ModpackPlatform, type SpecInput, type SpecPatch, type TemplateSpec,
} from "@mcsm/shared";
import { TYPED_PROPERTY_KEYS } from "./spec-catalog";

/** Form state: a SpecInput (without rconPassword). In templates, `ports` is ignored. */
export type EditableSpec = SpecInput;

/** Spec sections the form edits. Everything else (e.g. `backups`) is never touched. */
export const FORM_KEYS = [
  "imageTag", "type", "version", "memory", "properties", "env", "resources", "restartPolicy", "ports",
  "modpack", "mods", "plugins", "whitelist", "ops",
] as const;

/** One entry per line; commas are accepted too (pasting "lithium,sodium"). */
export function parseList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export function listToText(list: readonly string[] | undefined): string {
  return (list ?? []).join("\n");
}

/** `key=value` per line; `#` starts a comment. Throws an Error with a message for the user. */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(`Invalid line: "${line}" (use key=value)`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function kvToText(o: Record<string, string> | undefined): string {
  return Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** Splits the properties with a typed field from the rest ("Other properties"). */
export function splitProperties(props: Record<string, string>): { typed: Record<string, string>; other: Record<string, string> } {
  const typed: Record<string, string> = {};
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) (TYPED_PROPERTY_KEYS.has(k) ? typed : other)[k] = v;
  return { typed, other };
}

/** Sets (or removes, with undefined/"") a typed property. */
export function setProperty(props: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const out = { ...props };
  if (value === undefined || value === "") delete out[key];
  else out[key] = value;
  return out;
}

/** Replaces the "other" properties, keeping the typed ones. */
export function replaceOtherProperties(props: Record<string, string>, other: Record<string, string>): Record<string, string> {
  return { ...splitProperties(props).typed, ...other };
}

/** Removes what the UI does not edit, such as rconPassword. */
export function editableSpec<T extends Record<string, unknown>>(spec: T): Omit<T, "rconPassword"> {
  const { rconPassword: _secret, ...rest } = spec;
  return rest;
}

const isPlatform = (t: string): t is ModpackPlatform => (MODPACK_PLATFORMS as readonly string[]).includes(t);

/** Changes the type, keeping the modpack consistent (modpack type ⇔ modpack section). */
export function withType(spec: EditableSpec, type: string): EditableSpec {
  if (isPlatform(type)) {
    const prev = spec.modpack;
    return { ...spec, type, modpack: { platform: type, slugOrUrl: prev?.slugOrUrl ?? "", versionId: "", loader: "" } };
  }
  const { modpack: _drop, ...rest } = spec;
  return { ...rest, type };
}

/**
 * Minimal PATCH (top-level merge, see mergeSpecPatch in @mcsm/shared): only the sections
 * of FORM_KEYS that changed; `null` for those the form removed. Never touches anything else.
 */
export function buildSpecPatch(original: Record<string, unknown>, edited: Record<string, unknown>, keys: readonly string[] = FORM_KEYS): SpecPatch {
  const patch: SpecPatch = {};
  for (const k of keys) {
    const before = original[k];
    const after = edited[k];
    if (after === undefined) {
      if (before !== undefined) patch[k] = null;
    } else if (canonicalJson(after) !== canonicalJson(before)) {
      patch[k] = after;
    }
  }
  return patch;
}

/** Validates the way the panel will. Returns the first error ("path: message") or null. */
export function validateSpec(spec: EditableSpec, mode: "server" | "template"): string | null {
  if (mode === "template") {
    const { ports: _ports, ...rest } = spec;
    const r = templateSpecSchema.safeParse(rest);
    return r.success ? null : formatZodError(r.error);
  }
  const r = specInputSchema.safeParse(spec);
  return r.success ? null : formatZodError(r.error);
}

/** Initial state of the template editor from its spec. */
export function editableFromTemplate(spec: TemplateSpec): EditableSpec {
  return { ...spec, ports: { extra: [] } };
}
```

`panel/apps/web/src/lib/spec-diff.ts`:
```ts
export interface DiffLine { label: string; before: string; after: string }

const NONE = "—";

const TOP_LABELS: Record<string, string> = {
  type: "Type", version: "Minecraft version", imageTag: "Java (image)", memory: "Memory",
  restartPolicy: "Restart policy", modpack: "Modpack", whitelist: "Whitelist", ops: "Operators",
};
const NESTED_LABELS: Record<string, string> = {
  "resources.cpus": "CPU limit", "resources.memLimit": "Container RAM limit",
  "ports.game": "Game port", "ports.extra": "Extra ports",
  "mods.modrinthProjects": "Modrinth mods", "mods.curseforgeFiles": "CurseForge mods", "mods.urls": "Mods by URL",
  "plugins.modrinthProjects": "Modrinth plugins", "plugins.spigetResources": "Spiget plugins", "plugins.urls": "Plugins by URL",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function show(v: unknown): string {
  if (v === undefined || v === null || v === "") return NONE;
  if (Array.isArray(v)) return v.length ? v.map((x) => (isObj(x) ? JSON.stringify(x) : String(x))).join(", ") : NONE;
  if (isObj(v)) return JSON.stringify(v);
  return String(v);
}

function showModpack(v: unknown): string {
  if (!isObj(v)) return NONE;
  const ver = v.versionId ? ` @ ${String(v.versionId)}` : "";
  const loader = v.loader ? ` (${String(v.loader)})` : "";
  return `${String(v.platform)}: ${String(v.slugOrUrl)}${ver}${loader}`;
}

function showWhitelist(v: unknown): string {
  if (!isObj(v)) return NONE;
  const players = Array.isArray(v.players) && v.players.length ? `: ${v.players.join(", ")}` : "";
  return `${v.enabled ? "enabled" : "disabled"}${players}`;
}

function showPorts(v: unknown): string {
  if (!Array.isArray(v) || !v.length) return NONE;
  return v.map((p: Obj) => `${String(p.host)}→${String(p.container)}/${String(p.proto)}${p.label ? ` (${String(p.label)})` : ""}`).join(", ");
}

/** Flattens a spec into `label → text` to compare it line by line. */
function flatten(spec: Obj): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(spec)) {
    if (k === "rconPassword" || v === undefined) continue;
    if (k === "properties" && isObj(v)) for (const [pk, pv] of Object.entries(v)) out.set(`Property ${pk}`, show(pv));
    else if (k === "env" && isObj(v)) for (const [ek, ev] of Object.entries(v)) out.set(`Variable ${ek}`, show(ev));
    else if (k === "modpack") out.set(TOP_LABELS.modpack!, showModpack(v));
    else if (k === "whitelist") out.set(TOP_LABELS.whitelist!, showWhitelist(v));
    else if ((k === "resources" || k === "ports" || k === "mods" || k === "plugins") && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        const path = `${k}.${sk}`;
        out.set(NESTED_LABELS[path] ?? path, path === "ports.extra" ? showPorts(sv) : show(sv));
      }
    } else out.set(TOP_LABELS[k] ?? k, show(v));
  }
  return out;
}

/** Changes between two specs, in the order they appear; empty if they are equivalent. */
export function diffSpecs(before: Obj, after: Obj): DiffLine[] {
  const a = flatten(before);
  const b = flatten(after);
  const labels = [...new Set([...a.keys(), ...b.keys()])];
  const lines: DiffLine[] = [];
  for (const label of labels) {
    const x = a.get(label) ?? NONE;
    const y = b.get(label) ?? NONE;
    if (x !== y) lines.push({ label, before: x, after: y });
  }
  return lines;
}
```

In `panel/apps/web/src/lib/api.ts`, add `put` to the `api` object:
```ts
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
```
and at the end of the file:
```ts
export interface TemplateDto {
  id: string; name: string; description: string; spec: import("@mcsm/shared").TemplateSpec; sourceServerId: string | null;
  createdAt: string; updatedAt: string;
}
```

- [ ] **Step 4: Run (must pass)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/lib/
git commit -m "feat(web): configuration catalogs, minimal spec PATCH and readable diff

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — form fields and the «Version and mods» section

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/components/spec-form/fields.tsx`, `panel/apps/web/src/components/spec-form/curseforge-key.tsx`, `panel/apps/web/src/components/spec-form/version-section.tsx`, `panel/apps/web/src/components/spec-form/version-section.test.tsx`

**Interfaces:**
- Consumes: Task 6 (`spec-catalog`, `spec-edit`, `api.put`); `MODRINTH_LOADERS`, `usesCurseForge` (`@mcsm/shared`); endpoints `GET/PUT /api/settings/curseforge` (Task 4); shadcn components `Input`, `Label`, `Textarea`, `Select*`, `Dialog*`, `Button`.
- Produces:
  - `fields.tsx`: `type ReportError = (field: string, message: string | null) => void`, `Field`, `ListField` (list in a textarea, keeps its own text), `KvField` (key=value, reports through `onError`), `NumberField` (empty = `undefined`), `OptionalSelect` (with “(default)”; Radix does not accept `value=""`), `RequiredSelect` (adds the current value if it is not in the list).
  - `curseforge-key.tsx`: `CurseForgeKeyNotice` (status and dialog for the API key; never reads it back).
  - `version-section.tsx`: `VersionSection({ spec, onChange })`: type, version, Java, modpack depending on the platform, mods (mods/modpack types) and plugins (plugin types), CurseForge notice. When mods/plugins are emptied it **keeps the section** (the agent emits an empty `MODRINTH_PROJECTS` and itzg deletes what was installed).
- Text fields keep their local text: whoever uses them must remount them (changing `key`) when the spec is reloaded from outside.

- [ ] **Step 1: Smoke test (fails)**

The web's Vitest environment is `node` (no DOM): it is tested with `renderToString`, which runs the real components (Radix included) without a browser.

`panel/apps/web/src/components/spec-form/version-section.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { VersionSection } from "./version-section";
import { withType, type EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec) =>
  renderToString(<QueryClientProvider client={new QueryClient()}><VersionSection spec={spec} onChange={() => {}} /></QueryClientProvider>);

describe("VersionSection (server render, no DOM)", () => {
  it("Fabric shows Mods and not Plugins", () => {
    const html = render({ ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } });
    expect(html).toContain("MODRINTH_PROJECTS");
    expect(html).toContain("lithium");
    expect(html).not.toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CurseForge API key");
  });
  it("Paper shows Plugins and not Mods", () => {
    const html = render({ ...defaultSpecInput(), type: "PAPER" });
    expect(html).toContain("SPIGET_RESOURCES");
    expect(html).not.toContain("CURSEFORGE_FILES");
  });
  it("a CurseForge modpack asks for the slug and shows the API key status", () => {
    const html = render({ ...withType(defaultSpecInput(), "AUTO_CURSEFORGE"), modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" } });
    expect(html).toContain("CurseForge modpack");
    expect(html).toContain("all-the-mods-9");
    expect(html).toContain("CurseForge API key");
    expect(html).not.toContain("Loader (optional)");
  });
  it("Vanilla without mods explains that it loads no mods or plugins", () => {
    expect(render({ ...defaultSpecInput(), type: "VANILLA" })).toContain("Vanilla loads no mods or plugins");
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './version-section'`).

- [ ] **Step 3: Implementation**

`panel/apps/web/src/components/spec-form/fields.tsx`:
```tsx
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listToText, kvToText, parseKv, parseList } from "@/lib/spec-edit";

/** Reports field errors to the form (null = the field is valid again). */
export type ReportError = (field: string, message: string | null) => void;

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** List in a textarea (one entry per line). Keeps its own text so that line breaks are not lost while typing. */
export function ListField({ id, label, value, onChange, placeholder, hint, rows = 4 }: {
  id: string; label: string; value: readonly string[] | undefined; onChange: (v: string[]) => void;
  placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => listToText(value));
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value)); }} />
    </Field>
  );
}

/** key=value pairs in a textarea. If a line is invalid, it reports through onError and does not propagate the value. */
export function KvField({ id, label, value, onChange, onError, placeholder, hint, rows = 6 }: {
  id: string; label: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void;
  onError: ReportError; placeholder?: string; hint?: React.ReactNode; rows?: number;
}) {
  const [text, setText] = useState(() => kvToText(value));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    try {
      const kv = parseKv(t);
      setError(null); onError(id, null); onChange(kv);
    } catch (e) {
      const msg = `${label}: ${(e as Error).message}`;
      setError(msg); onError(id, msg);
    }
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Textarea id={id} rows={rows} className="font-mono text-xs" value={text} placeholder={placeholder}
        aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

/** Optional number (empty = undefined). Reports through onError if it is not a valid number in [min, max]. */
export function NumberField({ id, label, value, onChange, onError, min, max, integer = true, placeholder, hint }: {
  id: string; label: string; value: number | undefined; onChange: (v: number | undefined) => void; onError: ReportError;
  min?: number; max?: number; integer?: boolean; placeholder?: string; hint?: React.ReactNode;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : String(value)));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed === "") { setError(null); onError(id, null); onChange(undefined); return; }
    const n = Number(trimmed.replace(",", "."));
    const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max);
    if (bad) {
      const range = min !== undefined && max !== undefined ? ` between ${min} and ${max}` : min !== undefined ? ` ≥ ${min}` : "";
      const msg = `${label}: must be a ${integer ? "whole number" : "number"}${range}`;
      setError(msg); onError(id, msg); return;
    }
    setError(null); onError(id, null); onChange(n);
  };
  return (
    <Field id={id} label={label} hint={hint}>
      <Input id={id} value={text} inputMode={integer ? "numeric" : "decimal"} placeholder={placeholder} aria-invalid={!!error} onChange={(e) => update(e.target.value)} />
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </Field>
  );
}

const DEFAULT = "__default__"; // Radix Select does not accept value=""

/** Select with a "(default)" option that is equivalent to not setting the value. */
export function OptionalSelect({ id, value, options, onChange, defaultLabel = "(default)" }: {
  id: string; value: string | undefined; options: readonly { value: string; label: string }[]; onChange: (v: string | undefined) => void; defaultLabel?: string;
}) {
  const known = value === undefined || options.some((o) => o.value === value);
  const all = known ? options : [{ value: value!, label: value! }, ...options];
  return (
    <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? undefined : v)}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        {all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Required select; if the current value is not in the list (e.g. an imported type) it is added. */
export function RequiredSelect({ id, value, options, onChange }: {
  id: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void;
}) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{all.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
```

`panel/apps/web/src/components/spec-form/curseforge-key.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/api";

interface KeyStatus { configured: boolean }

/** Status of the global CurseForge API key and dialog to change it. The key is never read back. */
export function CurseForgeKeyNotice() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["settings", "curseforge"], queryFn: () => api.get<KeyStatus>("/api/settings/curseforge") });
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string) => api.put<KeyStatus>("/api/settings/curseforge", { apiKey }),
    onSuccess: (s) => {
      qc.setQueryData(["settings", "curseforge"], s);
      void qc.invalidateQueries({ queryKey: ["servers"] });
      setOpen(false); setKey("");
    },
  });
  const configured = status.data?.configured;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-xs">
      <KeyRound className="size-4 text-muted-foreground" />
      <span>
        CurseForge API key: {configured === undefined ? "…" : configured ? <strong className="text-emerald-400">set</strong> : <strong className="text-amber-400">not set</strong>}
        {configured === false && " (the java17+ images come with one; with java8 it is required)"}
      </span>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setKey(""); save.reset(); } }}>
        <DialogTrigger asChild><Button type="button" size="sm" variant="secondary">{configured ? "Change" : "Set up"}</Button></DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>CurseForge API key</DialogTitle>
            <DialogDescription>It is global for all servers. Changing it recreates the ones that download from CurseForge.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(key.trim()); }}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-api-key">New API key</Label>
              <Input id="cf-api-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="$2a$10$…" />
              <p className="text-xs text-muted-foreground">Get it from console.curseforge.com. Paste it as is: the “$” characters are not escaped.</p>
            </div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Unexpected error"}</p>}
            <DialogFooter>
              {configured && <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate("")}>Remove the key</Button>}
              <Button type="submit" disabled={save.isPending || key.trim() === ""}>{save.isPending ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/version-section.tsx`:
```tsx
import { MODRINTH_LOADERS, usesCurseForge } from "@mcsm/shared";
import { Input } from "@/components/ui/input";
import { JAVA_TAGS, SERVER_TYPES, typeKind } from "@/lib/spec-catalog";
import { withType, type EditableSpec } from "@/lib/spec-edit";
import { Field, ListField, OptionalSelect, RequiredSelect } from "./fields";
import { CurseForgeKeyNotice } from "./curseforge-key";

type Mods = NonNullable<EditableSpec["mods"]>;
type Plugins = NonNullable<EditableSpec["plugins"]>;
const EMPTY_MODS: Mods = { modrinthProjects: [], curseforgeFiles: [], urls: [] };
const EMPTY_PLUGINS: Plugins = { modrinthProjects: [], spigetResources: [], urls: [] };

const MODPACK_HELP: Record<string, { slug: string; slugHint: string; version: string; versionHint: string }> = {
  MODRINTH: {
    slug: "Modrinth modpack", slugHint: "Slug, id or URL from modrinth.com (MODRINTH_MODPACK).",
    version: "Modpack version (optional)", versionHint: "Version id or number (MODRINTH_VERSION). Empty = the latest compatible with the Minecraft version.",
  },
  AUTO_CURSEFORGE: {
    slug: "CurseForge modpack", slugHint: "Slug (CF_SLUG) or URL of the page or of a file (CF_PAGE_URL).",
    version: "File id (optional)", versionHint: "File number to pin the version (CF_FILE_ID). Empty = the latest.",
  },
  FTBA: {
    slug: "FTB modpack id", slugHint: "Modpack number (FTB_MODPACK_ID).",
    version: "Version id (optional)", versionHint: "Version number (FTB_MODPACK_VERSION_ID). Empty = the latest.",
  },
};

/** "Version and mods" section: type, version, Java, modpack, mods and plugins. */
export function VersionSection({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const kind = typeKind(spec.type);
  const mods = spec.mods ?? EMPTY_MODS;
  const plugins = spec.plugins ?? EMPTY_PLUGINS;
  const hasMods = Object.values(mods).some((l) => l.length > 0);
  const hasPlugins = Object.values(plugins).some((l) => l.length > 0);
  const showMods = kind === "mods" || kind === "modpack" || kind === "other" || hasMods;
  const showPlugins = kind === "plugins" || kind === "other" || hasPlugins;
  const mp = spec.modpack;
  const help = mp ? MODPACK_HELP[mp.platform] : undefined;
  // The section is kept even when empty: this way the agent emits an empty MODRINTH_PROJECTS and itzg
  // deletes what it installed (removing the last mod removes it from the server).
  const setMods = (m: Partial<Mods>) => onChange({ ...spec, mods: { ...mods, ...m } });
  const setPlugins = (p: Partial<Plugins>) => onChange({ ...spec, plugins: { ...plugins, ...p } });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id="sf-type" label="Type">
          <RequiredSelect id="sf-type" value={spec.type} options={SERVER_TYPES} onChange={(t) => onChange(withType(spec, t))} />
        </Field>
        <Field id="sf-version" label="Minecraft version" hint="LATEST, SNAPSHOT or a version such as 1.21.4.">
          <Input id="sf-version" value={spec.version} onChange={(e) => onChange({ ...spec, version: e.target.value.trim() })} />
        </Field>
        <Field id="sf-java" label="Java (image tag)" hint="java21 for 1.20.5+; java17 for 1.17–1.20.4; java8 for old versions.">
          <RequiredSelect id="sf-java" value={spec.imageTag} options={JAVA_TAGS.map((t) => ({ value: t, label: t }))} onChange={(t) => onChange({ ...spec, imageTag: t })} />
        </Field>
      </div>

      {mp && help && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Modpack</legend>
          <Field id="sf-mp-slug" label={help.slug} hint={help.slugHint}>
            <Input id="sf-mp-slug" value={mp.slugOrUrl} onChange={(e) => onChange({ ...spec, modpack: { ...mp, slugOrUrl: e.target.value.trim() } })} />
          </Field>
          <Field id="sf-mp-version" label={help.version} hint={help.versionHint}>
            <Input id="sf-mp-version" value={mp.versionId} onChange={(e) => onChange({ ...spec, modpack: { ...mp, versionId: e.target.value.trim() } })} />
          </Field>
          {mp.platform === "MODRINTH" && (
            <Field id="sf-mp-loader" label="Loader (optional)" hint="Only if the modpack publishes versions for several loaders.">
              <OptionalSelect id="sf-mp-loader" value={mp.loader || undefined}
                options={MODRINTH_LOADERS.filter((l) => l !== "").map((l) => ({ value: l, label: l }))}
                onChange={(l) => onChange({ ...spec, modpack: { ...mp, loader: (l ?? "") as typeof mp.loader } })} defaultLabel="(any)" />
            </Field>
          )}
        </fieldset>
      )}

      {showMods && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Mods</legend>
          <ListField id="sf-mods-modrinth" label="Modrinth (MODRINTH_PROJECTS)" value={mods.modrinthProjects} placeholder={"lithium\nferritecore:beta"}
            hint="Slug or id per line; “:beta” or “:version” to pin." onChange={(l) => setMods({ modrinthProjects: l })} />
          <ListField id="sf-mods-cf" label="CurseForge (CURSEFORGE_FILES)" value={mods.curseforgeFiles} placeholder={"jei\njei:4593548"}
            hint="Slug, id, slug:file or URL per line." onChange={(l) => setMods({ curseforgeFiles: l })} />
          <ListField id="sf-mods-urls" label="Jar URLs (MODS)" value={mods.urls} placeholder="https://…/mod.jar"
            hint="One http(s) URL per line. Removing a URL does not delete the .jar already downloaded." onChange={(l) => setMods({ urls: l })} />
        </fieldset>
      )}

      {showPlugins && (
        <fieldset className="grid grid-cols-1 gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Plugins</legend>
          <ListField id="sf-pl-modrinth" label="Modrinth (MODRINTH_PROJECTS)" value={plugins.modrinthProjects} placeholder={"luckperms\nchunky"}
            hint="Slug or id per line." onChange={(l) => setPlugins({ modrinthProjects: l })} />
          <ListField id="sf-pl-spiget" label="Spiget (SPIGET_RESOURCES)" value={plugins.spigetResources} placeholder={"28140\n34315"}
            hint="Numeric SpigotMC id per line. Some (e.g. EssentialsX) do not allow automatic download." onChange={(l) => setPlugins({ spigetResources: l })} />
          <ListField id="sf-pl-urls" label="Jar URLs (PLUGINS)" value={plugins.urls} placeholder="https://…/plugin.jar"
            hint="One http(s) URL per line. Removing a URL does not delete the .jar already downloaded." onChange={(l) => setPlugins({ urls: l })} />
        </fieldset>
      )}

      {kind === "vanilla" && !hasMods && !hasPlugins && (
        <p className="text-xs text-muted-foreground">Vanilla loads no mods or plugins. Choose Fabric/Forge/NeoForge/Quilt for mods or Paper/Purpur/Spigot for plugins.</p>
      )}
      {usesCurseForge(spec) && <CurseForgeKeyNotice />}
    </div>
  );
}
```

- [ ] **Step 4: Run (must pass)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS (4 new `VersionSection` tests).

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/components/spec-form/
git commit -m "feat(web): spec form fields and the Version and mods section with modpacks and the CurseForge API key

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web — Properties, Players, Network, Resources and Advanced sections, and `SpecForm`

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/components/spec-form/properties-section.tsx`, `players-section.tsx`, `network-section.tsx`, `resources-section.tsx`, `advanced-section.tsx`, `spec-form.tsx`, `spec-form.test.tsx` (all in `panel/apps/web/src/components/spec-form/`)

**Interfaces:**
- Consumes: Task 6 (`PROPERTY_DEFS`, `RESTART_POLICIES`, `setProperty`, `replaceOtherProperties`, `splitProperties`, `EditableSpec`), Task 7 (`Field`, `KvField`, `ListField`, `NumberField`, `OptionalSelect`, `RequiredSelect`, `ReportError`, `VersionSection`), shadcn `Tabs*`.
- Produces: `SpecForm({ value, onChange, onError, mode: "server" | "template", general: ReactNode })` with tabs **General, Version and mods, Properties, Players, Network (only `server`), Resources, Advanced** (no Backups: that belongs to Plan 4). All tabs are always mounted (`forceMount` + `data-[state=inactive]:hidden`) so the fields do not lose their text when switching tabs. Each section: `XSection({ spec, onChange, onError? })`.

- [ ] **Step 1: Smoke test (fails)**

`panel/apps/web/src/components/spec-form/spec-form.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultSpecInput } from "@mcsm/shared";
import { SpecForm } from "./spec-form";
import type { EditableSpec } from "@/lib/spec-edit";

const render = (spec: EditableSpec, mode: "server" | "template") =>
  renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <SpecForm value={spec} onChange={() => {}} onError={() => {}} mode={mode} general={<p>general content</p>} />
    </QueryClientProvider>,
  );

describe("SpecForm (server render, no DOM)", () => {
  const modded: EditableSpec = {
    ...defaultSpecInput(), type: "AUTO_CURSEFORGE", version: "1.20.1",
    modpack: { platform: "AUTO_CURSEFORGE", slugOrUrl: "all-the-mods-9", versionId: "", loader: "" },
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    properties: { motd: "Hola", difficulty: "hard", "max-players": "8", "custom-x": "1" },
    whitelist: { enabled: true, players: ["Lobo"] }, ops: ["Lobo"], env: { USE_AIKAR_FLAGS: "true" },
    ports: { game: 25565, extra: [{ host: 19132, container: 19132, proto: "udp", label: "Geyser" }] },
  };

  it("renders all sections (forceMount) with values", () => {
    const html = render(modded, "server");
    for (const t of ["General", "Version and mods", "Properties", "Players", "Network", "Resources", "Advanced", "general content"]) expect(html).toContain(t);
    for (const v of ["all-the-mods-9", "lithium", "Lobo", "custom-x=1", "USE_AIKAR_FLAGS=true", "Geyser", "CurseForge API key"]) expect(html).toContain(v);
    expect(html).not.toContain("Backups");
  });

  it("templates have no Network section", () => {
    const html = render({ ...defaultSpecInput(), ports: { extra: [] } }, "template");
    expect(html).not.toContain("Game port");
    expect(html).toContain("Advanced");
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './spec-form'`).

- [ ] **Step 3: Sections**

`panel/apps/web/src/components/spec-form/properties-section.tsx`:
```tsx
import { Input } from "@/components/ui/input";
import { PROPERTY_DEFS, type PropDef } from "@/lib/spec-catalog";
import { replaceOtherProperties, setProperty, splitProperties, type EditableSpec } from "@/lib/spec-edit";
import { Field, KvField, NumberField, OptionalSelect, type ReportError } from "./fields";

const BOOL_OPTIONS = [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] as const;

function TypedProperty({ def, value, onChange, onError }: { def: PropDef; value: string | undefined; onChange: (v: string | undefined) => void; onError: ReportError }) {
  const id = `sf-prop-${def.key}`;
  const label = `${def.label} (${def.key})`;
  if (def.kind === "bool") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={BOOL_OPTIONS} onChange={onChange} /></Field>;
  if (def.kind === "enum") return <Field id={id} label={label}><OptionalSelect id={id} value={value} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} onChange={onChange} /></Field>;
  if (def.kind === "int") {
    const n = value === undefined || value === "" ? undefined : Number(value);
    return <NumberField id={id} label={label} value={Number.isFinite(n) ? n : undefined} min={def.min} max={def.max} placeholder={def.placeholder}
      onError={onError} onChange={(v) => onChange(v === undefined ? undefined : String(v))} />;
  }
  return <Field id={id} label={label}><Input id={id} value={value ?? ""} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} /></Field>;
}

/** "Properties" section: ~20 typed fields plus the rest of server.properties as text. Empty = the image's default value. */
export function PropertiesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const props = spec.properties;
  const { other } = splitProperties(props);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROPERTY_DEFS.map((def) => (
          <TypedProperty key={def.key} def={def} value={props[def.key]} onError={onError}
            onChange={(v) => onChange({ ...spec, properties: setProperty(spec.properties, def.key, v) })} />
        ))}
      </div>
      <KvField id="sf-props-other" label="Other server.properties entries (key=value per line)" value={other} onError={onError}
        placeholder={"spawn-npcs=true\nresource-pack=https://…"} hint="They are passed with CUSTOM_SERVER_PROPERTIES. server-port, enable-rcon and rcon.* are not accepted."
        onChange={(kv) => onChange({ ...spec, properties: replaceOtherProperties(spec.properties, kv) })} />
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/players-section.tsx`:
```tsx
import type { EditableSpec } from "@/lib/spec-edit";
import { ListField } from "./fields";

/** "Players" section: whitelist and operators (WHITELIST/ENABLE_WHITELIST and OPS). */
export function PlayersSection({ spec, onChange }: { spec: EditableSpec; onChange: (s: EditableSpec) => void }) {
  const wl = spec.whitelist ?? { enabled: false, players: [] };
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={wl.enabled} onChange={(e) => onChange({ ...spec, whitelist: { ...wl, enabled: e.target.checked } })} />
          Enable whitelist (only listed players can join)
        </label>
        <ListField id="sf-whitelist" label="Whitelisted players" value={wl.players} rows={6} placeholder={"Lobo\nSteve"}
          hint="Java name or UUID, one per line. On start, whitelist.json is made identical to this list: anything added with /whitelist add is lost (set EXISTING_WHITELIST_FILE=MERGE in Advanced if you prefer to add to it)."
          onChange={(players) => onChange({ ...spec, whitelist: { ...wl, players } })} />
      </div>
      <ListField id="sf-ops" label="Operators (OPS)" value={spec.ops} rows={6} placeholder="Lobo"
        hint="Java name or UUID, one per line. Removing someone here removes their op on restart (empty list = ops.json is not touched)."
        onChange={(ops) => onChange({ ...spec, ops: ops.length ? ops : undefined })} />
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/network-section.tsx`:
```tsx
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EditableSpec } from "@/lib/spec-edit";
import { NumberField, RequiredSelect, type ReportError } from "./fields";

type Extra = EditableSpec["ports"]["extra"][number];
const PROTOS = [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }] as const;

function toPort(text: string): number { const n = Number(text); return Number.isInteger(n) ? n : 0; }

/** "Network" section: game port (on the host) and extra ports (Geyser, voice, web maps…). */
export function NetworkSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  const extra = spec.ports.extra;
  const setExtra = (list: Extra[]) => onChange({ ...spec, ports: { ...spec.ports, extra: list } });
  const update = (i: number, patch: Partial<Extra>) => setExtra(extra.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xs">
        <NumberField id="sf-port" label="Game port (host)" value={spec.ports.game} min={1} max={65535} onError={onError}
          hint="Inside the container it is always 25565. Empty = the panel picks a free one."
          onChange={(game) => onChange({ ...spec, ports: { ...spec.ports, game } })} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Extra ports</div>
        {extra.length === 0 && <p className="text-xs text-muted-foreground">None. RCON (25575) is never published.</p>}
        {extra.map((e, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_6rem_1.5fr_auto] items-center gap-2">
            <Input aria-label="Host port" inputMode="numeric" value={e.host || ""} placeholder="host" onChange={(ev) => update(i, { host: toPort(ev.target.value) })} />
            <Input aria-label="Container port" inputMode="numeric" value={e.container || ""} placeholder="container" onChange={(ev) => update(i, { container: toPort(ev.target.value) })} />
            <RequiredSelect id={`sf-proto-${i}`} value={e.proto} options={PROTOS} onChange={(p) => update(i, { proto: p as Extra["proto"] })} />
            <Input aria-label="Label" value={e.label} maxLength={40} placeholder="Geyser, voice…" onChange={(ev) => update(i, { label: ev.target.value })} />
            <Button type="button" size="icon" variant="ghost" aria-label="Remove port" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <div>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExtra([...extra, { host: 0, container: 0, proto: "tcp", label: "" }])}>
            <Plus className="size-4" /> Add port
          </Button>
        </div>
      </div>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/resources-section.tsx`:
```tsx
import { Input } from "@/components/ui/input";
import { RESTART_POLICIES } from "@/lib/spec-catalog";
import type { EditableSpec } from "@/lib/spec-edit";
import { Field, NumberField, RequiredSelect, type ReportError } from "./fields";

/** "Resources" section: JVM memory, container limits and restart policy. */
export function ResourcesSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field id="sf-memory" label="JVM memory (MEMORY)" hint="E.g. 4G or 512M.">
        <Input id="sf-memory" value={spec.memory} onChange={(e) => onChange({ ...spec, memory: e.target.value.trim() })} />
      </Field>
      <Field id="sf-memlimit" label="Container RAM limit" hint="Empty = no limit. If you set one, at least the JVM memory (better +1G).">
        <Input id="sf-memlimit" value={spec.resources.memLimit} placeholder="5G" onChange={(e) => onChange({ ...spec, resources: { ...spec.resources, memLimit: e.target.value.trim() } })} />
      </Field>
      <NumberField id="sf-cpus" label="CPU limit" value={spec.resources.cpus || undefined} min={0} max={256} integer={false} placeholder="2" onError={onError}
        hint="Empty = no limit. Decimals are accepted (1.5)." onChange={(cpus) => onChange({ ...spec, resources: { ...spec.resources, cpus: cpus ?? 0 } })} />
      <Field id="sf-restart" label="Restart policy">
        <RequiredSelect id="sf-restart" value={spec.restartPolicy} options={RESTART_POLICIES}
          onChange={(v) => onChange({ ...spec, restartPolicy: v as EditableSpec["restartPolicy"] })} />
      </Field>
    </div>
  );
}
```

`panel/apps/web/src/components/spec-form/advanced-section.tsx`:
```tsx
import type { EditableSpec } from "@/lib/spec-edit";
import { KvField, type ReportError } from "./fields";

/** "Advanced" section: free environment variables for the itzg image (they override what is generated). */
export function AdvancedSection({ spec, onChange, onError }: { spec: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError }) {
  return (
    <KvField id="sf-env" label="Extra environment variables (KEY=value per line)" value={spec.env} rows={10} onError={onError}
      placeholder={"USE_AIKAR_FLAGS=true\nENABLE_AUTOPAUSE=false\nMODRINTH_DOWNLOAD_DEPENDENCIES=required"}
      hint="They override what the other sections generate. EULA, TYPE, VERSION, MEMORY, RCON_*, SERVER_PORT, CUSTOM_SERVER_PROPERTIES and CF_API_KEY cannot be set (the CurseForge API key is configured separately)."
      onChange={(env) => onChange({ ...spec, env })} />
  );
}
```

- [ ] **Step 4: Composition**

`panel/apps/web/src/components/spec-form/spec-form.tsx`:
```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EditableSpec } from "@/lib/spec-edit";
import type { ReportError } from "./fields";
import { VersionSection } from "./version-section";
import { PropertiesSection } from "./properties-section";
import { PlayersSection } from "./players-section";
import { NetworkSection } from "./network-section";
import { ResourcesSection } from "./resources-section";
import { AdvancedSection } from "./advanced-section";

/**
 * Spec form split into sections (spec §8). Controlled: `value` + `onChange`. Used by the Configuration tab
 * (mode "server") and the template editor (mode "template", no Network).
 * The Backups section belongs to Plan 4 and lives in its own tab.
 * `general` is the content specific to whoever uses it (name, description, RCON…).
 */
export function SpecForm({ value, onChange, onError, mode, general }: {
  value: EditableSpec; onChange: (s: EditableSpec) => void; onError: ReportError; mode: "server" | "template"; general: React.ReactNode;
}) {
  const props = { spec: value, onChange, onError };
  return (
    <Tabs defaultValue="general" className="flex flex-col gap-4">
      <TabsList className="flex-wrap">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="version">Version and mods</TabsTrigger>
        <TabsTrigger value="properties">Properties</TabsTrigger>
        <TabsTrigger value="players">Players</TabsTrigger>
        {mode === "server" && <TabsTrigger value="network">Network</TabsTrigger>}
        <TabsTrigger value="resources">Resources</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>
      {/* forceMount: the fields keep their local text; unmounting them when switching tabs would lose it. */}
      <TabsContent forceMount value="general" className="data-[state=inactive]:hidden">{general}</TabsContent>
      <TabsContent forceMount value="version" className="data-[state=inactive]:hidden"><VersionSection spec={value} onChange={onChange} /></TabsContent>
      <TabsContent forceMount value="properties" className="data-[state=inactive]:hidden"><PropertiesSection {...props} /></TabsContent>
      <TabsContent forceMount value="players" className="data-[state=inactive]:hidden"><PlayersSection spec={value} onChange={onChange} /></TabsContent>
      {mode === "server" && <TabsContent forceMount value="network" className="data-[state=inactive]:hidden"><NetworkSection {...props} /></TabsContent>}
      <TabsContent forceMount value="resources" className="data-[state=inactive]:hidden"><ResourcesSection {...props} /></TabsContent>
      <TabsContent forceMount value="advanced" className="data-[state=inactive]:hidden"><AdvancedSection {...props} /></TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 5: Run (must pass)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck
```
Expected: PASS (2 `SpecForm` tests: all sections render their values, none is called “Backups”, and templates have no Network).

- [ ] **Step 6: Commit**

```bash
git add panel/apps/web/src/components/spec-form/
git commit -m "feat(web): section-based spec form with typed properties, players, network, resources and advanced

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web — Templates page and template editor

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/hooks/use-templates.ts`, `panel/apps/web/src/routes/templates.tsx`, `panel/apps/web/src/routes/template-edit.tsx`
- Modify: `panel/apps/web/src/router.tsx` (below the anchor `plan-3`), `panel/apps/web/src/components/layout.tsx` (navigation entry, outside the anchor)

**Interfaces:**
- Consumes: template endpoints (Task 5), `TemplateDto`/`api` (Task 6), `SpecForm`/`Field` (Tasks 7–8), `FORM_KEYS`, `buildSpecPatch`, `editableFromTemplate`, `validateSpec` (Task 6), `useServers` (Plan 1), `defaultSpecInput` (`@mcsm/shared`).
- Produces: hooks `useTemplates()` (query `["templates"]`) and `useTemplate(id)` (query `["template", id]`); pages `TemplatesPage` (`/templates`: list, create server → `/servers/new?template=<id>`, edit, duplicate, delete with confirmation), `NewTemplatePage` (`/templates/new`) and `EditTemplatePage` (`/templates/$templateId`, route id `/app/templates/$templateId`); exports `templatesRoute`, `newTemplateRoute`, `templateRoute`; «Templates» entry in the sidebar.

- [ ] **Step 1: Hooks and pages**

`panel/apps/web/src/hooks/use-templates.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import { api, type TemplateDto } from "@/lib/api";

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => api.get<TemplateDto[]>("/api/templates") });
}

export function useTemplate(id: string) {
  return useQuery({ queryKey: ["template", id], queryFn: () => api.get<TemplateDto>(`/api/templates/${id}`) });
}
```

`panel/apps/web/src/routes/templates.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, type TemplateDto } from "@/lib/api";
import { typeLabel } from "@/lib/spec-catalog";
import { useTemplates } from "@/hooks/use-templates";
import { useServers } from "@/hooks/use-servers";

/** Templates page: list, create, edit, duplicate, delete and "create server from template". */
export function TemplatesPage() {
  const templates = useTemplates();
  const servers = useServers();
  const qc = useQueryClient();
  const [toDelete, setToDelete] = useState<TemplateDto | null>(null);
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<TemplateDto>(`/api/templates/${id}/duplicate`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/templates/${id}`),
    onSuccess: () => { setToDelete(null); void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  const serverName = (id: string | null) => (id ? servers.data?.find((s) => s.id === id)?.name : undefined);
  const actionError = duplicate.error ?? del.error;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Templates</h1>
        <Button asChild><Link to="/templates/new"><Plus className="size-4" /> New template</Link></Button>
      </div>
      <p className="text-sm text-muted-foreground">A template stores a server's whole configuration except name, ports and RCON password. Create them from scratch or with “Save as template” in a server's configuration.</p>
      {templates.isError && <p role="alert" className="text-sm text-red-400">Could not load the templates: {templates.error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-red-400">{actionError instanceof ApiError ? actionError.message : "Unexpected error"}</p>}
      <Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Memory</TableHead><TableHead>Source</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {templates.isPending && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Loading templates…</TableCell></TableRow>}
          {templates.data?.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No templates yet.</TableCell></TableRow>}
          {templates.data?.map((t) => (
            <TableRow key={t.id} data-testid={`template-row-${t.id}`}>
              <TableCell>
                <Link to="/templates/$templateId" params={{ templateId: t.id }} className="font-medium hover:underline">{t.name}</Link>
                {t.description && <div className="max-w-md truncate text-xs text-muted-foreground">{t.description}</div>}
              </TableCell>
              <TableCell>{typeLabel(t.spec.type)} {t.spec.version}{t.spec.modpack ? ` · ${t.spec.modpack.slugOrUrl}` : ""}</TableCell>
              <TableCell>{t.spec.memory}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{t.sourceServerId ? `“${serverName(t.sourceServerId) ?? "server"}”` : "—"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button asChild size="sm"><Link to="/servers/new" search={{ template: t.id }}><Rocket className="size-4" /> Create server</Link></Button>
                  <Button asChild size="icon" variant="ghost" aria-label={`Edit ${t.name}`}><Link to="/templates/$templateId" params={{ templateId: t.id }}><Pencil className="size-4" /></Link></Button>
                  <Button size="icon" variant="ghost" aria-label={`Duplicate ${t.name}`} disabled={duplicate.isPending} onClick={() => duplicate.mutate(t.id)}><Copy className="size-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => { del.reset(); setToDelete(t); }}><Trash2 className="size-4" /></Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o && !del.isPending) setToDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete the template “{toDelete?.name}”</DialogTitle>
            <DialogDescription>Servers created from it are not affected.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={del.isPending} onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => toDelete && del.mutate(toDelete.id)}>{del.isPending ? "Deleting…" : "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

`panel/apps/web/src/routes/template-edit.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { defaultSpecInput } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SpecForm } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { api, ApiError, type TemplateDto } from "@/lib/api";
import { FORM_KEYS, buildSpecPatch, editableFromTemplate, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { useTemplate } from "@/hooks/use-templates";

const TEMPLATE_KEYS = FORM_KEYS.filter((k) => k !== "ports");
const withoutPorts = ({ ports: _ports, ...rest }: EditableSpec) => rest;

function TemplateEditor({ template }: { template?: TemplateDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const initial = template ? editableFromTemplate(template.spec) : defaultSpecInput();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [spec, setSpec] = useState<EditableSpec>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const reportError = (field: string, message: string | null) =>
    setErrors((e) => {
      if (message === null) { if (!(field in e)) return e; const { [field]: _gone, ...rest } = e; return rest; }
      return e[field] === message ? e : { ...e, [field]: message };
    });

  const save = useMutation({
    mutationFn: () => template
      ? api.patch<TemplateDto>(`/api/templates/${template.id}`, {
        name: name.trim(), description: description.trim(),
        spec: buildSpecPatch(editableFromTemplate(template.spec), spec, TEMPLATE_KEYS),
      })
      : api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), spec: withoutPorts(spec) }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["templates"] });
      qc.setQueryData(["template", t.id], t);
      void navigate({ to: "/templates" });
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    if (!name.trim()) return setLocalErr("The name is required");
    const fieldError = Object.values(errors)[0];
    if (fieldError) return setLocalErr(fieldError);
    const invalid = validateSpec(spec, "template");
    if (invalid) return setLocalErr(invalid);
    save.mutate();
  };

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="tpl-name" label="Template name"><Input id="tpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="tpl-desc" label="Description (optional)"><Textarea id="tpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Templates do not store ports or the RCON password: the panel assigns them when creating each server.</p>
    </div>
  );
  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Unexpected error" : null);

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{template ? `Template “${template.name}”` : "New template"}</h1>
        <Button asChild variant="ghost"><Link to="/templates">Back</Link></Button>
      </div>
      <SpecForm value={spec} onChange={setSpec} onError={reportError} mode="template" general={general} />
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <div><Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : template ? "Save changes" : "Create template"}</Button></div>
    </form>
  );
}

export function NewTemplatePage() {
  return <TemplateEditor />;
}

export function EditTemplatePage() {
  const { templateId } = useParams({ from: "/app/templates/$templateId" });
  const q = useTemplate(templateId);
  if (q.isPending) return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <div role="alert" className="p-6 text-red-400">{notFound ? "Template not found" : `Could not load the template: ${q.error.message}`}</div>;
  }
  return <TemplateEditor key={q.data.id} template={q.data} />;
}
```

- [ ] **Step 2: Routes and navigation**

In `panel/apps/web/src/router.tsx`, imports alongside the others:
```ts
import { TemplatesPage } from "./routes/templates";
import { EditTemplatePage, NewTemplatePage } from "./routes/template-edit";
```
below the anchor `plan-3` of the route definitions (or right above `routeTree` if the anchor is only in the tree):
```ts
// ── plan-3 ──
export const templatesRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates", component: TemplatesPage });
export const newTemplateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/new", component: NewTemplatePage });
export const templateRoute = createRoute({ getParentRoute: () => appRoute, path: "/templates/$templateId", component: EditTemplatePage });
```
and in the children of `appRoute`, below the anchor `plan-3`: `templatesRoute, newTemplateRoute, templateRoute`. (TanStack Router prioritizes the static segment `new` over `$templateId`, just as `/servers/new` over `/servers/$serverId`.)

In `panel/apps/web/src/components/layout.tsx` (outside the anchor), import `LayoutTemplate` from `lucide-react` and add to the `nav` array, after “Nodes”:
```ts
  { to: "/templates", label: "Templates", icon: LayoutTemplate },
```

- [ ] **Step 3: Verify**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS and the build without errors. Manual test (`pnpm dev:api` + `pnpm dev:web`, signed in): **Templates → New template**, type Fabric, mod `lithium`, save → it appears in the list as “Fabric LATEST”; **Duplicate** creates “… (copy)”; **Edit** keeps the values; **Delete** asks for confirmation; reloading `/templates/<id>` directly works; a template with the type “Modrinth modpack” and no slug shows “modpack.slugOrUrl: …” and is not saved.

- [ ] **Step 4: Commit**

```bash
git add panel/apps/web/src/
git commit -m "feat(web): templates page with editor, duplicate, delete and create server from template

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web — Configuration tab by sections, diff before applying and «Save as template»

**Agent:** web-ui-dev

**Files:**
- Replace: `panel/apps/web/src/components/server-config-form.tsx` (the Plan 1 one)
- Create: `panel/apps/web/src/components/save-template-dialog.tsx`, `panel/apps/web/src/components/server-config-form.test.tsx`
- Delete: `panel/apps/web/src/lib/spec-form.ts`, `panel/apps/web/src/lib/spec-form.test.ts` (only the old form used them; `spec-edit.ts` replaces them)

**Interfaces:**
- Consumes: `SpecForm`, `Field` (Tasks 7–8); `buildSpecPatch`, `editableSpec`, `validateSpec`, `EditableSpec` (Task 6); `diffSpecs`, `DiffLine` (Task 6); `canonicalJson`, `mergeSpecPatch`, `SpecPatch` (`@mcsm/shared`); `POST /api/templates {fromServerId}` (Task 5); `ServerDto` (Plan 1).
- Produces: `ServerConfigForm({ server: ServerDto })` with the **same signature** as Plan 1's, so `routes/server.tsx` is not touched (`<ServerConfigForm key={s.id} server={s} />`). Kept from Plan 1: detection of changes made elsewhere (different version with/without local changes), revealing RCON and the dialog of changes before applying. New: minimal PATCH (`{ name? , spec?: SpecPatch }`), diff with English labels computed against what will remain after the merge, notice that the container will be recreated, and `SaveTemplateDialog({ server })`.

- [ ] **Step 1: Smoke test (fails)**

`panel/apps/web/src/components/server-config-form.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerConfigForm } from "./server-config-form";
import type { ServerDto } from "@/lib/api";

const server: ServerDto = {
  id: "s1", nodeId: "n1", name: "Supervivencia", slug: "supervivencia", specVersion: 3, desiredState: "running",
  observed: null, observedSpecVersion: 3, observedAt: null, createdAt: "", updatedAt: "",
  spec: {
    imageTag: "java21", type: "FABRIC", version: "1.21.4", memory: "4G", properties: { motd: "Hola" }, env: {},
    resources: { cpus: 0, memLimit: "" }, restartPolicy: "unless-stopped",
    mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] },
    ports: { game: 25565, extra: [] }, rconPassword: "secretosecreto",
  },
};

describe("ServerConfigForm (server render)", () => {
  it("renders the sectioned form, hides RCON and offers save as template", () => {
    const html = renderToString(<QueryClientProvider client={new QueryClient()}><ServerConfigForm server={server} /></QueryClientProvider>);
    expect(html).toContain("Supervivencia");
    expect(html).toContain("mcsm-supervivencia");
    expect(html).toContain("lithium");
    expect(html).toContain("Save as template");
    expect(html).toContain("Review and apply");
    expect(html).not.toContain("secretosecreto");
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (the Plan 1 form does not contain “Save as template” or `mcsm-supervivencia`).

- [ ] **Step 3: Implementation**

`panel/apps/web/src/components/save-template-dialog.tsx`:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api, ApiError, type ServerDto, type TemplateDto } from "@/lib/api";

/** "Save as template": copies the server's APPLIED spec without ports or rconPassword (the panel removes them). */
export function SaveTemplateDialog({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const save = useMutation({
    mutationFn: () => api.post<TemplateDto>("/api/templates", { name: name.trim(), description: description.trim(), fromServerId: server.id }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setName(server.name); setDescription(""); save.reset(); } }}>
      <DialogTrigger asChild><Button type="button" variant="secondary"><BookmarkPlus className="size-4" /> Save as template</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save “{server.name}” as template</DialogTitle>
          <DialogDescription>The applied configuration (v{server.specVersion}) is saved without ports or the RCON password. Unapplied changes are not included.</DialogDescription>
        </DialogHeader>
        {save.isSuccess ? (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-emerald-400">Template “{save.data.name}” created.</p>
            <DialogFooter>
              <Button asChild variant="secondary"><Link to="/templates">View templates</Link></Button>
              <Button type="button" onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <div className="flex flex-col gap-1.5"><Label htmlFor="tpl-name">Name</Label><Input id="tpl-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="tpl-desc">Description (optional)</Label><Textarea id="tpl-desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            {save.error && <p role="alert" className="text-sm text-red-400">{save.error instanceof ApiError ? save.error.message : "Unexpected error"}</p>}
            <DialogFooter><Button type="submit" disabled={save.isPending || !name.trim()}>{save.isPending ? "Saving…" : "Save template"}</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Replace `panel/apps/web/src/components/server-config-form.tsx` entirely with:
```tsx
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { canonicalJson, mergeSpecPatch, type SpecPatch } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SpecForm } from "@/components/spec-form/spec-form";
import { Field } from "@/components/spec-form/fields";
import { SaveTemplateDialog } from "@/components/save-template-dialog";
import { api, ApiError, type ServerDto } from "@/lib/api";
import { buildSpecPatch, editableSpec, validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { diffSpecs, type DiffLine } from "@/lib/spec-diff";

interface Pending { name?: string; spec?: SpecPatch; changes: DiffLine[]; recreate: boolean }

const toEditable = (s: ServerDto): EditableSpec => editableSpec(s.spec) as EditableSpec;

/** Configuration tab: sectioned form, diff before applying and minimal PATCH (merge). */
export function ServerConfigForm({ server }: { server: ServerDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(server.name);
  const [spec, setSpec] = useState<EditableSpec>(() => toEditable(server));
  // Baseline: what was loaded into the form and its version (to detect changes made elsewhere).
  const [base, setBase] = useState(() => ({ version: server.specVersion, name: server.name, spec: toEditable(server) }));
  const [formKey, setFormKey] = useState(0); // remounts the fields (which keep local text) on reload
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [showRcon, setShowRcon] = useState(false);

  const dirty = name !== base.name || canonicalJson(spec) !== canonicalJson(base.spec);
  const stale = server.specVersion !== base.version;
  const resetTo = (s: ServerDto) => {
    const sp = toEditable(s);
    setName(s.name); setSpec(sp); setBase({ version: s.specVersion, name: s.name, spec: sp });
    setErrors({}); setLocalErr(null); setFormKey((k) => k + 1);
  };
  useEffect(() => { if (stale && !dirty) resetTo(server); }, [stale, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const reportError = (field: string, message: string | null) =>
    setErrors((e) => {
      if (message === null) { if (!(field in e)) return e; const { [field]: _gone, ...rest } = e; return rest; }
      return e[field] === message ? e : { ...e, [field]: message };
    });

  const save = useMutation({
    mutationFn: (p: Pending) => api.patch<ServerDto>(`/api/servers/${server.id}`, { ...(p.name ? { name: p.name } : {}), ...(p.spec ? { spec: p.spec } : {}) }),
    onSuccess: (dto) => {
      setPending(null);
      resetTo(dto);
      qc.setQueryData(["server", server.id], dto);
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: () => setPending(null),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setLocalErr(null); save.reset();
    const trimmed = name.trim();
    if (!trimmed) return setLocalErr("The name cannot be empty");
    const fieldError = Object.values(errors)[0];
    if (fieldError) return setLocalErr(fieldError);
    const invalid = validateSpec(spec, "server");
    if (invalid) return setLocalErr(invalid);
    const patch = buildSpecPatch(base.spec, spec);
    const hasSpec = Object.keys(patch).length > 0;
    // The diff compares what is saved with what will remain after the panel's merge.
    const changes = hasSpec ? diffSpecs(base.spec, mergeSpecPatch(base.spec, patch)) : [];
    if (trimmed !== base.name) changes.unshift({ label: "Name", before: base.name, after: trimmed });
    if (changes.length === 0) return setLocalErr("There are no changes to apply");
    setPending({ name: trimmed !== base.name ? trimmed : undefined, spec: hasSpec ? patch : undefined, changes, recreate: hasSpec });
  };

  const err = localErr ?? (save.error instanceof ApiError ? save.error.message : save.error ? "Unexpected error" : null);

  const general = (
    <div className="flex max-w-xl flex-col gap-4">
      <Field id="cf-name" label="Name"><Input id="cf-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="text-sm text-muted-foreground">Slug <code className="rounded bg-muted px-1">{server.slug}</code> · container <code className="rounded bg-muted px-1">{`mcsm-${server.slug}`}</code></div>
      {server.spec.rconPassword && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>RCON password:</span>
          <code className="rounded bg-muted px-1.5 py-0.5" data-testid="rcon">{showRcon ? server.spec.rconPassword : "••••••••••••"}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShowRcon((s) => !s)} aria-pressed={showRcon}>
            {showRcon ? <EyeOff className="size-4" /> : <Eye className="size-4" />}{showRcon ? "Hide" : "Reveal"}
          </Button>
        </div>
      )}
      <div><SaveTemplateDialog server={server} /></div>
    </div>
  );

  return (
    <form onSubmit={submit} className="flex max-w-5xl flex-col gap-6" data-testid="config-form">
      <SpecForm key={formKey} value={spec} onChange={setSpec} onError={reportError} mode="server" general={general} />
      {stale && dirty && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700 bg-amber-950/30 p-2 text-sm text-amber-300">
          The configuration changed on the server (v{server.specVersion}) and you have unsaved changes.
          <Button type="button" size="sm" variant="secondary" onClick={() => resetTo(server)}>Reload and discard my changes</Button>
        </p>
      )}
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-400">Saved (v{save.data.specVersion}). The agent will recreate the container if needed.</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={save.isPending}>Review and apply</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => resetTo(server)}>Discard changes</Button>}
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Apply changes to “{base.name}”</DialogTitle>
            <DialogDescription>{pending?.recreate ? "The container will be recreated: if the server is running, it will restart (the world is not touched)." : "Only the name changes: the container is not touched."}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-1 overflow-auto text-xs" data-testid="spec-diff">
            {pending?.changes.map((c) => (
              <li key={c.label} className="rounded border border-border p-2">
                <div className="text-muted-foreground">{c.label}</div>
                <div className="break-all font-mono text-red-300">- {c.before}</div>
                <div className="break-all font-mono text-emerald-300">+ {c.after}</div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>Cancel</Button>
            <Button type="button" disabled={save.isPending} onClick={() => pending && save.mutate(pending)}>{save.isPending ? "Applying…" : "Apply"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
```

Delete the old form and its logic:
```bash
git rm panel/apps/web/src/lib/spec-form.ts panel/apps/web/src/lib/spec-form.test.ts
grep -rn "lib/spec-form\|@/routes/new-server" panel/apps/web/src || true
```
Expected from `grep`: no results (the new form imports the catalogs from `lib/spec-catalog`, not from `routes/new-server`).

- [ ] **Step 4: Run (must pass)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS and the build without errors.

Manual test with an existing server (`pnpm dev:api`, `pnpm dev:web`, the dev compose agent): **Configuration** tab → tabs General/Version and mods/Properties/Players/Network/Resources/Advanced (no Backups). Change “Difficulty” to `hard` and add `Lobo` to the enabled whitelist → **Review and apply** shows “Property difficulty: — → hard” and “Whitelist: — → enabled: Lobo” and warns that the container will be recreated → **Apply** → “Saved (vN)” and the state goes through “Applying vN…”. Changing only the name says “Only the name changes” and does not increment the version. Typing `motd` (without `=`) in “Other properties” shows the error and blocks submission. **Save as template** creates the template and offers “View templates”.

- [ ] **Step 5: Commit**

```bash
git add -A panel/apps/web/src/
git commit -m "feat(web): configuration by sections with diff, minimal PATCH and save as template

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — new server wizard in 3 steps

**Agent:** web-ui-dev

**Files:**
- Create: `panel/apps/web/src/lib/wizard.ts`, `panel/apps/web/src/lib/wizard.test.ts`
- Replace: `panel/apps/web/src/routes/new-server.tsx` (the one-step one from Plan 1)
- Modify: `panel/apps/web/src/router.tsx` (`newServerRoute` with `validateSearch`, outside the anchor)

**Interfaces:**
- Consumes: `POST /api/servers` (Plan 1, spec merged with defaults), `POST /api/templates/:id/servers` (Task 5), `useTemplates` (Task 9), `useNodes` (Plan 1), `VersionSection`/`Field` (Task 7), `validateSpec`, `EditableSpec` (Task 6), `typeLabel` (Task 6), `slugify`/`defaultSpecInput` (`@mcsm/shared`).
- Produces: `createRequest(source, target): { url, body }`, `summarizeSpec(spec): {label, value}[]`, `WizardTarget`; `NewServerPage` in 3 steps (**Template or from scratch → Node and name → Review**), which accepts `?template=<id>` (starts at step 2 with that template). `newServerRoute` validates the search as `{ template?: string }`.

- [ ] **Step 1: Test (fails)**

`panel/apps/web/src/lib/wizard.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { defaultSpecInput, templateSpecSchema } from "@mcsm/shared";
import { createRequest, summarizeSpec } from "./wizard";

describe("new server wizard", () => {
  it("from a template calls the template endpoint and only passes the port if one was given", () => {
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: " Survival ", start: true })).toEqual({
      url: "/api/templates/t1/servers", body: { nodeId: "n", name: "Survival", desiredState: "running" },
    });
    expect(createRequest({ templateId: "t1" }, { nodeId: "n", name: "S", port: 25570, start: false }).body).toMatchObject({ port: 25570, desiredState: "stopped" });
  });
  it("from scratch sends the spec with the game port only if one was given", () => {
    const spec = { ...defaultSpecInput(), type: "FABRIC", mods: { modrinthProjects: ["lithium"], curseforgeFiles: [], urls: [] } };
    const r = createRequest({ spec }, { nodeId: "n", name: "Fabric", start: true });
    expect(r.url).toBe("/api/servers");
    expect(r.body.spec).toMatchObject({ type: "FABRIC", mods: { modrinthProjects: ["lithium"] }, ports: { extra: [] } });
    expect((r.body.spec as { ports: object }).ports).not.toHaveProperty("game");
    expect(createRequest({ spec }, { nodeId: "n", name: "F", port: 25599, start: true }).body.spec).toMatchObject({ ports: { game: 25599 } });
  });
  it("summarizes the spec", () => {
    const t = templateSpecSchema.parse({ type: "MODRINTH", modpack: { platform: "MODRINTH", slugOrUrl: "cobblemon-fabric" }, memory: "6G", whitelist: { enabled: true, players: ["Lobo"] }, mods: { modrinthProjects: ["a", "b"] } });
    expect(summarizeSpec(t)).toEqual(expect.arrayContaining([
      { label: "Type", value: "Modrinth modpack" },
      { label: "Modpack", value: "cobblemon-fabric" },
      { label: "Memory", value: "6G" },
      { label: "Mods", value: "2 mods" },
      { label: "Whitelist", value: "1 player" },
    ]));
  });
});
```

- [ ] **Step 2: Run (must fail)**

```bash
pnpm --filter @mcsm/web test
```
Expected: FAIL (`Cannot find module './wizard'`).

- [ ] **Step 3: Implementation**

`panel/apps/web/src/lib/wizard.ts`:
```ts
import type { TemplateSpec } from "@mcsm/shared";
import type { EditableSpec } from "./spec-edit";
import { typeLabel } from "./spec-catalog";

export interface WizardTarget { nodeId: string; name: string; port?: number; start: boolean }

/** Creation request: from a template (the panel copies its spec) or from scratch (spec from step 1). */
export function createRequest(source: { templateId: string } | { spec: EditableSpec }, t: WizardTarget): { url: string; body: Record<string, unknown> } {
  const desiredState = t.start ? "running" : "stopped";
  if ("templateId" in source) {
    return { url: `/api/templates/${source.templateId}/servers`, body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, ...(t.port ? { port: t.port } : {}) } };
  }
  const ports = t.port ? { game: t.port, extra: source.spec.ports.extra } : { extra: source.spec.ports.extra };
  return { url: "/api/servers", body: { nodeId: t.nodeId, name: t.name.trim(), desiredState, spec: { ...source.spec, ports } } };
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** Readable summary of a spec for the "Review" step. */
export function summarizeSpec(spec: TemplateSpec | EditableSpec): { label: string; value: string }[] {
  const mods = spec.mods ? spec.mods.modrinthProjects.length + spec.mods.curseforgeFiles.length + spec.mods.urls.length : 0;
  const plugins = spec.plugins ? spec.plugins.modrinthProjects.length + spec.plugins.spigetResources.length + spec.plugins.urls.length : 0;
  const lines = [
    { label: "Type", value: typeLabel(spec.type) },
    { label: "Minecraft version", value: spec.version },
    { label: "Java", value: spec.imageTag },
    { label: "Memory", value: spec.memory + (spec.resources.memLimit ? ` (limit ${spec.resources.memLimit})` : "") },
  ];
  if (spec.modpack) lines.push({ label: "Modpack", value: spec.modpack.slugOrUrl + (spec.modpack.versionId ? ` @ ${spec.modpack.versionId}` : "") });
  if (mods) lines.push({ label: "Mods", value: count(mods, "mod", "mods") });
  if (plugins) lines.push({ label: "Plugins", value: count(plugins, "plugin", "plugins") });
  if (spec.whitelist) lines.push({ label: "Whitelist", value: spec.whitelist.enabled ? count(spec.whitelist.players.length, "player", "players") : "disabled" });
  if (spec.ops?.length) lines.push({ label: "Operators", value: spec.ops.join(", ") });
  const props = Object.keys(spec.properties).length;
  if (props) lines.push({ label: "Properties", value: count(props, "property set", "properties set") });
  return lines;
}
```

Replace `panel/apps/web/src/routes/new-server.tsx` entirely with:
```tsx
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { defaultSpecInput, slugify } from "@mcsm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/spec-form/fields";
import { VersionSection } from "@/components/spec-form/version-section";
import { api, type ServerDto } from "@/lib/api";
import { validateSpec, type EditableSpec } from "@/lib/spec-edit";
import { createRequest, summarizeSpec } from "@/lib/wizard";
import { typeLabel } from "@/lib/spec-catalog";
import { cn } from "@/lib/utils";
import { useNodes } from "@/hooks/use-nodes";
import { useTemplates } from "@/hooks/use-templates";

type Step = 1 | 2 | 3;
const STEPS: { n: Step; label: string }[] = [{ n: 1, label: "Template or from scratch" }, { n: 2, label: "Node and name" }, { n: 3, label: "Review" }];
const SCRATCH = "__scratch__";

/** New server wizard in 3 steps (spec §8). `?template=<id>` opens it with that template selected. */
export function NewServerPage() {
  const { template: preselected } = useSearch({ from: "/app/servers/new" });
  const nodes = useNodes();
  const templates = useTemplates();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(preselected ? 2 : 1);
  const [source, setSource] = useState<string>(preselected ?? SCRATCH);
  const [spec, setSpec] = useState<EditableSpec>(() => ({ ...defaultSpecInput(), type: "PAPER", imageTag: "java21", memory: "4G" }));
  const [nodeId, setNodeId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [start, setStart] = useState(true);
  const [stepErr, setStepErr] = useState<string | null>(null);

  const tpl = source === SCRATCH ? undefined : templates.data?.find((t) => t.id === source);
  const portNum = port.trim() === "" ? undefined : Number(port);
  const portInvalid = portNum !== undefined && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535);
  const selectedNode = nodes.data?.find((n) => n.id === nodeId);
  const online = nodes.data?.filter((n) => n.status === "online") ?? [];

  const create = useMutation({
    mutationFn: () => {
      // Never create "from scratch" by mistake if the template has not loaded yet or was deleted.
      if (source !== SCRATCH && !tpl) throw new Error("The chosen template is not available (was it deleted?)");
      const req = createRequest(tpl ? { templateId: tpl.id } : { spec }, { nodeId, name, port: portNum, start });
      return api.post<ServerDto>(req.url, req.body);
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void navigate({ to: "/servers/$serverId", params: { serverId: s.id } });
    },
  });

  const next = () => {
    setStepErr(null);
    if (step === 1) {
      if (source !== SCRATCH && !tpl) return setStepErr("The chosen template no longer exists");
      if (source === SCRATCH) { const invalid = validateSpec(spec, "server"); if (invalid) return setStepErr(invalid); }
      return setStep(2);
    }
    if (step === 2) {
      if (!nodeId) return setStepErr("Choose a node");
      if (!name.trim()) return setStepErr("Enter a name");
      if (portInvalid) return setStepErr("The port must be a number between 1 and 65535");
      return setStep(3);
    }
  };
  const back = () => { setStepErr(null); create.reset(); setStep((s) => (s > 1 ? ((s - 1) as Step) : s)); };

  const summary = tpl ? summarizeSpec(tpl.spec) : source === SCRATCH ? summarizeSpec(spec) : [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s) => (
          <li key={s.n} aria-current={s.n === step ? "step" : undefined}
            className={cn("rounded-full border px-3 py-1", s.n === step ? "border-ring bg-accent" : s.n < step ? "border-emerald-800 text-emerald-400" : "border-border text-muted-foreground")}>
            {s.n < step ? <Check className="mr-1 inline size-3" /> : `${s.n}. `}{s.label}
          </li>
        ))}
      </ol>

      <Card className="max-w-4xl">
        <CardHeader><CardTitle>New server</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-5">
          {step === 1 && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Source">
                <SourceCard selected={source === SCRATCH} onSelect={() => setSource(SCRATCH)} title="From scratch" subtitle="Choose type, version and mods. Everything else is adjusted later in Configuration." />
                {templates.data?.map((t) => (
                  <SourceCard key={t.id} selected={source === t.id} onSelect={() => setSource(t.id)} title={t.name}
                    subtitle={`${typeLabel(t.spec.type)} ${t.spec.version} · ${t.spec.memory}${t.description ? ` · ${t.description}` : ""}`} />
                ))}
              </div>
              {templates.isError && <p role="alert" className="text-xs text-red-400">Could not load the templates: {templates.error.message}</p>}
              {source === SCRATCH && (
                <div className="flex flex-col gap-4 border-t border-border pt-4">
                  <VersionSection spec={spec} onChange={setSpec} />
                  <div className="max-w-xs">
                    <Field id="ns-mem" label="JVM memory" hint="E.g. 4G or 512M.">
                      <Input id="ns-mem" value={spec.memory} onChange={(e) => setSpec({ ...spec, memory: e.target.value.trim() })} />
                    </Field>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="ns-node" label="Node">
                <Select value={nodeId} onValueChange={setNodeId}>
                  <SelectTrigger id="ns-node"><SelectValue placeholder={nodes.isPending ? "Loading nodes…" : "Choose a node"} /></SelectTrigger>
                  <SelectContent>{nodes.data?.map((n) => <SelectItem key={n.id} value={n.id}>{n.name}{n.status !== "online" ? " (offline, will be created when it comes back)" : ""}</SelectItem>)}</SelectContent>
                </Select>
                {nodes.isError && <p role="alert" className="text-xs text-red-400">Could not load the nodes: {nodes.error.message}</p>}
                {selectedNode && selectedNode.status !== "online" && <p className="text-xs text-amber-400">The node “{selectedNode.name}” is offline: the server will be created but will not start until it comes back.</p>}
                {nodes.data && online.length === 0 && <p className="text-xs text-amber-400">No node is connected: the server will be created when the node comes back.</p>}
              </Field>
              <Field id="ns-name" label="Name" hint={name.trim() ? <>Folder and container: <code>{slugify(name)}</code> (if it already exists, -2, -3… is added)</> : undefined}>
                <Input id="ns-name" value={name} maxLength={60} placeholder="Survival 2026" onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field id="ns-port" label="Game port (empty = automatic)">
                <Input id="ns-port" value={port} inputMode="numeric" placeholder="25565" aria-invalid={portInvalid} onChange={(e) => setPort(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start on creation</label>
            </div>
          )}

          {step === 3 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm" data-testid="wizard-summary">
              <dt className="text-muted-foreground">Source</dt><dd>{tpl ? `Template “${tpl.name}”` : source === SCRATCH ? "From scratch" : "Template (loading…)"}</dd>
              {summary.map((l) => <Row key={l.label} label={l.label} value={l.value} />)}
              <Row label="Node" value={selectedNode?.name ?? "—"} />
              <Row label="Name" value={name.trim()} />
              <Row label="Port" value={portNum ? String(portNum) : "automatic"} />
              <Row label="On creation" value={start ? "start" : "leave stopped"} />
            </dl>
          )}

          {stepErr && <p role="alert" className="text-sm text-red-400">{stepErr}</p>}
          {create.error && <p role="alert" className="text-sm text-red-400">{create.error.message}</p>}
          <div className="flex justify-between">
            <Button type="button" variant="ghost" disabled={step === 1 || create.isPending} onClick={back}><ArrowLeft className="size-4" /> Back</Button>
            {step < 3
              ? <Button type="button" onClick={next}>Next <ArrowRight className="size-4" /></Button>
              : <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Creating…" : "Create server"}</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></>;
}

function SourceCard({ selected, onSelect, title, subtitle }: { selected: boolean; onSelect: () => void; title: string; subtitle: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect}
      className={cn("flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm hover:border-ring", selected ? "border-ring bg-accent" : "border-border")}>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}
```

In `panel/apps/web/src/router.tsx` (outside the anchor), replace the `newServerRoute` definition with:
```ts
export const newServerRoute = createRoute({
  getParentRoute: () => appRoute, path: "/servers/new", component: NewServerPage,
  // plan-3: ?template=<id> opens the wizard with that template selected.
  validateSearch: (s: Record<string, unknown>): { template?: string } => (typeof s.template === "string" && s.template ? { template: s.template } : {}),
});
```
(Existing `<Link to="/servers/new">` without `search` still compile: the key is optional.)

- [ ] **Step 4: Run (must pass)**

```bash
pnpm --filter @mcsm/web test && pnpm --filter @mcsm/web typecheck && pnpm --filter @mcsm/web build
```
Expected: PASS and the build without errors.

Manual test: **New server** → step 1 “From scratch”, type Fabric, version `1.21.4`, Java `java21`, mod `lithium` → Next → step 2 node + name (shows the slug) → step 3 summarizes “Type Fabric · Mods 1 mod · Port automatic” → Create → navigates to the detail. From **Templates → Create server** the wizard opens at step 2 with the chosen template and step 3 says “Source: Template “…”. Choosing “Modrinth modpack” without a slug and pressing Next shows “modpack.slugOrUrl: …” and does not advance.

- [ ] **Step 5: Commit**

```bash
git add panel/apps/web/src/
git commit -m "feat(web): new server wizard in 3 steps, from scratch or from a template

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end verification and acceptance criteria

**Agent:** infra-dev (real Docker; if something fails for no obvious reason, `debugger`)

**Files:**
- Modify (only if there are deviations): this plan, as a footnote to this task.

**Interfaces:**
- Consumes: everything above; `deploy/docker-compose.dev.yml` from Plan 1 (agent in Docker against the panel on the host, external network `mcsm`).
- Produces: evidence for the acceptance criteria in the plans README (Plan 3): *creating a Fabric server with `MODRINTH_PROJECTS=lithium` starts and the console shows the mod download; a template reproduces an identical server except for name, port and RCON.*

This repo's Docker rules: only `mcsm-test-…` resources are created (compose project `mcsm-test-p3`, servers with slug `test-…` → containers `mcsm-test-fabric`, `mcsm-test-fabric-copia`) and they are deleted at the end. No `docker system prune` and no touching foreign containers. In Claude Code, the waits (`until …; do sleep …; done`) run with the Monitor tool; the panel, with `run_in_background`.

- [ ] **Step 1: Full verification**

```bash
eval "$(mise env)" && pnpm lint:proto && (cd agent && go vet ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build
```
Expected: everything green. `buf breaking` does not apply: this plan does not touch `proto/`.

- [ ] **Step 2: Test environment**

```bash
export E2E=/tmp/mcsm-test-p3 J=/tmp/mcsm-test-p3/cookies API=http://localhost:8080
mkdir -p $E2E/panel $E2E/data
docker network inspect mcsm >/dev/null 2>&1 || { docker network create mcsm && touch $E2E/created-network; }
```
Start the panel in the background (it needs port 8080 free: the dev compose points to `host.docker.internal:8080`):
```bash
PORT=8080 DATA_DIR=$E2E/panel pnpm --filter @mcsm/api start
```
Node enrollment and agent with this plan's code:
```bash
curl -sf -c $J -H 'content-type: application/json' -d '{"password":"correct horse battery"}' $API/api/auth/setup
TOKEN=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nameHint\":\"test-p3\",\"dataRoot\":\"$E2E/data\"}" $API/api/nodes/enrollment-tokens | jq -r .token)
ENROLL_TOKEN=$TOKEN DATA_ROOT=$E2E/data docker compose -p mcsm-test-p3 -f deploy/docker-compose.dev.yml up -d --build
until [ "$(curl -sf -b $J $API/api/nodes | jq -r '.[0].status')" = online ]; do sleep 2; done
NODE=$(curl -sf -b $J $API/api/nodes | jq -r '.[0].id')
```
Expected: the node becomes `online` within seconds.

- [ ] **Step 3: Acceptance 1 — Fabric with `lithium`**

```bash
S1=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nodeId\":\"$NODE\",\"name\":\"Test Fabric\",\"slug\":\"test-fabric\",\"desiredState\":\"running\",\"spec\":{\"type\":\"FABRIC\",\"version\":\"1.21.4\",\"imageTag\":\"java21\",\"memory\":\"2G\",\"mods\":{\"modrinthProjects\":[\"lithium\"]},\"properties\":{\"motd\":\"Plan 3\",\"difficulty\":\"hard\"},\"whitelist\":{\"enabled\":true,\"players\":[\"Lobo\"]},\"ops\":[\"Lobo\"]}}" $API/api/servers | jq -r .id)
until docker inspect mcsm-test-fabric >/dev/null 2>&1; do sleep 2; done
docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(TYPE|MODRINTH_PROJECTS|ENABLE_WHITELIST|WHITELIST|OPS|EXISTING_[A-Z_]+|CF_API_KEY|MODPACK_PLATFORM)=' | sort
```
Expected (exactly these lines; neither `CF_API_KEY` nor `MODPACK_PLATFORM`):
```
ENABLE_WHITELIST=true
EXISTING_OPS_FILE=SYNCHRONIZE
EXISTING_WHITELIST_FILE=SYNCHRONIZE
MODRINTH_PROJECTS=lithium
OPS=Lobo
TYPE=FABRIC
WHITELIST=Lobo
```
Open the web (`pnpm dev:web`, `http://localhost:5173`, password `correct horse battery`) → “Test Fabric” → **Console** while it starts: the download lines for `lithium` (mc-image-helper) appear and, when Fabric loads, the mod list with `- lithium …`. From the terminal:
```bash
until docker logs mcsm-test-fabric 2>&1 | grep -q 'Done ('; do sleep 5; done
docker logs mcsm-test-fabric 2>&1 | grep -i lithium
ls $E2E/data/test-fabric/data/mods/
```
Expected: several lines with `lithium` (download and Fabric's `- lithium <version>`); in `mods/` a `lithium-fabric-*.jar`. In the web the server shows “Running” with the applied version.

- [ ] **Step 4: Acceptance 2 — the template reproduces the server except name, port and RCON**

```bash
TPL=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"name\":\"test-p3 Fabric\",\"fromServerId\":\"$S1\"}" $API/api/templates)
echo "$TPL" | jq '.spec | has("ports"), has("rconPassword")'
S2=$(curl -sf -b $J -H 'content-type: application/json' -d "{\"nodeId\":\"$NODE\",\"name\":\"Test Fabric copia\",\"desiredState\":\"stopped\"}" $API/api/templates/$(echo "$TPL" | jq -r .id)/servers | jq -r .id)
diff <(curl -sf -b $J $API/api/servers/$S1 | jq -S '.spec | del(.ports, .rconPassword)') \
     <(curl -sf -b $J $API/api/servers/$S2 | jq -S '.spec | del(.ports, .rconPassword)') && echo SPEC_IGUAL
curl -sf -b $J $API/api/servers/$S1 | jq -c '[.slug, .spec.ports.game, (.spec.rconPassword|length)]'
curl -sf -b $J $API/api/servers/$S2 | jq -c '[.slug, .spec.ports.game, (.spec.rconPassword|length)]'
until docker inspect mcsm-test-fabric-copia >/dev/null 2>&1; do sleep 2; done
diff <(docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^RCON_PASSWORD=') \
     <(docker inspect mcsm-test-fabric-copia --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^RCON_PASSWORD=') && echo ENV_IGUAL
```
Expected: `false` `false`; `SPEC_IGUAL`; two lines with slugs `test-fabric` / `test-fabric-copia`, different ports and RCON of 43 characters (different: compare them with `.spec.rconPassword`); `ENV_IGUAL` (the copy's container differs only in `RCON_PASSWORD` and in the published port).

- [ ] **Step 5: Checks of the risks from the Review Focus**

```bash
# 3. Partial PATCH: only ops; the rest is kept and the agent applies it
curl -sf -b $J -X PATCH -H 'content-type: application/json' -d '{"spec":{"ops":["Lobo","Steve"]}}' $API/api/servers/$S1 | jq -c '[.specVersion, .spec.type, .spec.mods.modrinthProjects, .spec.whitelist.enabled]'
until docker inspect mcsm-test-fabric --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'OPS=Lobo,Steve'; do sleep 2; done && echo OPS_APLICADO
# 4. The CurseForge key never leaves toward the browser and does not recreate servers that do not use CurseForge
curl -sf -b $J -X PUT -H 'content-type: application/json' -d '{"apiKey":"$2a$10$test-p3-falsa"}' $API/api/settings/curseforge
curl -sf -b $J $API/api/servers | grep -c 'test-p3-falsa' || true
curl -sf -b $J $API/api/servers/$S1 | jq .specVersion
curl -sf -b $J -X PUT -H 'content-type: application/json' -d '{"apiKey":""}' $API/api/settings/curseforge
```
Expected: `[2,"FABRIC",["lithium"],true]`, then `OPS_APLICADO`; `{"configured":true}`; `0`; S1's version stays at `2` (it does not use CurseForge); `{"configured":false}`.

- [ ] **Step 6: UI walkthrough**

With the web open, check and note any failure:
1. **New server**: the 3 steps; “From scratch” with “Modrinth modpack” and no slug does not advance and shows `modpack.slugOrUrl: …`; from **Templates → Create server** it opens at step 2 with the chosen template. (No need to create it: “Back” and leave.)
2. **Configuration of “Test Fabric”**: tabs General, Version and mods, Properties, Players, Network, Resources, Advanced and **no Backups**; change “Difficulty” to `normal` → the dialog shows “Property difficulty: hard → normal” and warns about recreation; **Apply** → “Applying v3…” → “Running”.
3. Type “CurseForge modpack” in an unsaved form shows “CurseForge API key: not set” and the dialog to set it (do not save it; discard the changes).
4. **Templates**: this test's template appears with “Fabric 1.21.4” and source “Test Fabric”; **Duplicate** and **Delete** work.

- [ ] **Step 7: Cleanup**

```bash
curl -sf -b $J -X DELETE "$API/api/servers/$S1?deleteData=true" -o /dev/null -w '%{http_code}\n'
curl -sf -b $J -X DELETE "$API/api/servers/$S2?deleteData=true" -o /dev/null -w '%{http_code}\n'
docker compose -p mcsm-test-p3 -f deploy/docker-compose.dev.yml down -v
[ -f $E2E/created-network ] && docker network rm mcsm
```
Stop the panel in the background and delete `$E2E` (`rm -rf /tmp/mcsm-test-p3`). Expected: `204` `204`; `docker ps -a --filter name=mcsm-test-` empty.

- [ ] **Step 8: Closing**

If something deviated from the plan (itzg variable names, messages, UI behavior), note it as a footnote to this task and commit only that note:
```bash
git add docs/superpowers/plans/2026-10-12-03-configuration-templates.md
git commit -m "docs: verification notes for plan 3

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
If there were no deviations, there is no commit.

> **Verification notes (executed):** all criteria green with real Docker. Deviations from the procedure: (1) on this machine the firewall drops container → host, so the panel ran as container `mcsm-test-panel` on the `mcsm` network and the agent with `PANEL_URL=http://mcsm-test-panel:8080` in a compose override; (2) `buf breaking` is invoked with `--against ".git#ref=<commit>"` (with `#commit=` and a short SHA it fails); (3) the cleanup `down -v` needs `DATA_ROOT` defined; (4) the UI walkthrough (Step 6) was not done: Claude's browser blocks `localhost:8080`, left for the human; (5) with `CF_API_KEY` the key does appear in the `docker inspect` of the MC container (unavoidable, it goes in env) and nowhere else (forwarded console, agent and panel logs, DTOs).

---

## Closing the plan

With Task 12 green, the system meets step 5 of the spec's build order (§13) except for the Backups section of the form, which Plan 4 adds in its own tab. Before merging wave A:

- Branch review with `final-reviewer` and `security-auditor` (CurseForge API key, env reservations).
- Notes for `CLAUDE.md` (the controller adds them): spec PATCH = top-level merge (`mergeSpecPatch`, `null` deletes) and the form only sends `FORM_KEYS`; `CF_API_KEY` reserved and only in `toServerSpecMessage(row, { curseforgeApiKey })`; spec regex ASCII only (no `\s`) so that Go and zod match, and cases in `proto/fixtures/spec-content-cases.json`; zod in Spanish via `zod-locale.ts`; the web's Vitest does smoke tests with `renderToString`.
- Points of contact with the other plans of the wave: Plan 4 sends `PATCH { spec: { backups } }` (depends on Task 3) and its `backups` field must go in `baseFields` (so templates include it) and **not** generate env (it must not change the hash); the “Templates” entry in `layout.tsx` and `api.put` may trivially clash with other entries; Plan 9 reuses `GET/PUT /api/settings/curseforge`; Plans 6–7 must call `toServerSpecMessage(row, { curseforgeApiKey })` and Plan 6 must map `CF_API_KEY` from imported containers to Settings (it is reserved).
