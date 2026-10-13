# Implementation plans — roadmap

The spec (`docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`) is built in sequential
plans. Each plan leaves the system usable and tested. Plans 2 onward are detailed (with the same
granularity as Plan 1) once the previous one is integrated, because their tasks depend on the
final shape of the code that exists by then; here their scope, order and acceptance criteria are
fixed so that nothing has to be redesigned.

Plans 1–10 were written and executed while the project was in Spanish and were translated
afterwards: their rules about Spanish UI messages and Spanish commits are historical. The current
conventions (English) are the ones in `CLAUDE.md`.

| # | Plan | Spec | Status |
|---|------|------|--------|
| 1 | [Foundations](2026-10-12-01-foundations.md): protocol, reconciling agent, panel with nodes/servers, logs and console, basic UI, deployment | §3, §4, §5, §6.1–6.3, §7, §8, §9, §10, §12 | done (branch `feat/plan-1`) |
| 2 | [Metrics](2026-10-12-02-metrics.md) | §4 `metric_samples`, §6.4, §8 (charts) | done (branch `feat/wave-b`) |
| 3 | [Full configuration and templates](2026-10-12-03-configuration-templates.md) | §4.1 complete, §4 `templates`, §8 (sectioned form, wizard) | done (branch `feat/wave-b`) |
| 4 | [Backups](2026-10-12-04-backups.md) | §4 `backups`/`jobs`, §6.5, §7 `JobService`/`BackupService`, §8 (Backups and History tabs) | done (branch `feat/wave-b`) |
| 5 | [Files](2026-10-12-05-files.md) | §6.6, HTTP transfers §5.1, §8 (Files tab) | done (branch `feat/wave-b`) |
| 6 | [Importing existing servers](2026-10-12-06-import.md) | §6.7, §7 `ImportService`, §8 (Nodes → Import) | done (branch `feat/wave-b`) |
| 7 | [Migration between nodes](2026-10-12-07-migration.md) | §7 `MigrationService` | done (branch `feat/wave-b`) |
| 8 | [mc-router](2026-10-12-08-mc-router.md) | §4 `router_deployments`, §7 `RouterService` | done (branch `feat/wave-b`) |
| 9 | [UI tests and polish](2026-10-12-09-polish.md) | §11 (Playwright), §8 (Settings), §5.2–5.3, §9, §10 | done (branch `feat/plan-9-int`) |
| 10 | [Version picker](2026-10-13-10-version-selector.md) | [own spec](../specs/2026-10-13-version-selector-design.md) | done (branch `feat/plan-10`) |

Execution in parallel waves: see [COORDINATION.md](COORDINATION.md).

## Plan 2 — Metrics

Scope: the agent adds `MetricSample` (CPU %, memory, network, players, ping, TPS on Paper/Purpur
via RCON `tps`) every 10 s for running servers and for the host (gopsutil: CPU, RAM, disk of
`DATA_ROOT`). The panel ingests in batches into `metric_samples`, purges to 7 days every hour, and exposes
`GET /api/servers/:id/metrics?range=1h|24h|7d` and `GET /api/nodes/:id/metrics` aggregating on the fly
(10 s / 1 min / 5 min). The UI adds charts (players, CPU, RAM) in the server Overview and
node cards with live CPU/RAM/disk.
Acceptance: with a server running for 2 minutes, the 1 h chart shows ≥ 10 points; after
restarting the panel, the history is still there; the table doesn't exceed ~70k rows per server per week.
Protocol: new `MetricBatch` message in `agent.proto` (`buf breaking` must pass).

## Plan 3 — Full configuration and templates

Scope: the spec grows with `modpack`, `mods`, `plugins`, `whitelist`, `ops` (§4.1) and the agent's
`BuildContainer` translates them to `MODPACK_PLATFORM`, `MODRINTH_MODPACK`, `CF_SLUG`/`CF_PAGE_URL`,
`CF_API_KEY` (global from Settings), `MODRINTH_PROJECTS`, `SPIGET_RESOURCES`, `MODS`/`PLUGINS` (URLs),
`WHITELIST`, `ENABLE_WHITELIST`, `OPS`, with cross-validation (modpack ↔ compatible type).
Sectioned form (General, Version and mods, Properties with typed fields for the ~20
most used, Players, Network with extra ports, Resources, Backups (placeholder until Plan 4),
Advanced) and a diff view before applying. Templates: `templates` table, CRUD, "save as
template", "create from template", duplicate; new-server wizard in 3 steps.
Acceptance: creating a Fabric server with `MODRINTH_PROJECTS=lithium` starts and the console shows
the mod download; a template reproduces an identical server except for name, port and RCON.

## Plan 4 — Backups

Scope: in the agent, `backup` package (tar.zst with `klauspost/compress`, `save-off`/`save-all
flush`/`save-on` with `defer`, exclusions, `.json` metadata, sha256, pruning by days/count,
`robfig/cron` scheduling from the spec, `onlyIfPlayersSince`), restore with `data.pre-restore-<ts>`
renaming, messages `BackupNow/List/Restore/Delete` + `BackupCreated` + `JobProgress`.
Panel: `backups` and `jobs` tables, generic `JobService` with progress and log, download via
`GET /agent/transfer/:id` ↔ `BackupPush`. UI: Backups tab (list, create now, restore,
download, delete) and Jobs page.
Acceptance: manual backup of a running world without the server being left with autosave
disabled (check with `save-on` in the logs); restoring leaves the previous world renamed;
scheduled at `* * * * *` it produces one file per minute and respects `keepCount`.

## Plan 5 — Files

Scope: `Files*` in the agent with confinement (`EvalSymlinks` + prefix), atomic writes,
2 MiB inline limit, streaming upload/download via `/agent/transfer`. UI: `/data` browser,
text editor (CodeMirror 6) for `.properties/.yml/.json/.toml/.txt`, upload, download,
rename, delete, create folder.
Acceptance: a path `../../etc/passwd` returns 400; uploading a 50 MB `.jar` to `mods/` works
and the server loads it on restart.

## Plan 6 — Import

Scope: `ImportScan`/`ImportCandidates`/`ImportAdopt`; the panel builds the candidate spec (known
env → fields; rest → `env`; port `25565/tcp`; `/data` bind → explicit `dataPath` if
it doesn't hang under `DATA_ROOT`, a new optional field in the spec and in `BuildContainer`). UI in Nodes →
Import with review and editing before adopting. Hot adoption (without recreating): the agent
follows the container by `imported_from.container_id` until the first spec change.
Acceptance: your current compose servers appear as candidates, are adopted without downtime and
show logs/players; the first "Review and apply" recreates them with `mcsm.*` labels and the
same data directory.

## Plan 7 — Migration

Scope: `MigrationService` as a 7-step job (§7) reusing backup/transfer/restore; UI
"Migrate to another node" with node selection, proposed port, "delete source" option.
Acceptance: migrating a 500 MB world between two LAN nodes with the server stopped keeps
the world and the spec (version +1, new port if it clashes); if the target fails to start, the
source is left intact and running.

## Plan 8 — mc-router

Scope: `router_deployments` table, `RouterApply/RouterRemove` in the agent (container
`itzg/mc-router` with `-in-docker` and the socket mounted, host port 25565), `mc-router.host`
labels on servers with `router.enabled`, optional autoscale. UI in Nodes.
Acceptance: with local DNS `*.lan` pointing to the node, `survival.lan` and `creative.lan` reach
different servers through 25565.

## Plan 9 — UI tests and polish

Scope: crash-loop detection (§10: >3 restarts per hour → stop and warn) and the agent's `Event` message (§5.3, `Envelope` field 24) with its view in the web; Playwright on `deploy/docker-compose.yml` + real agent: login, create server, console,
backup and restore, migration between two agents on the same machine (two `DATA_ROOT`s). Settings
page (password, public URL, CurseForge API key, port range). Node token rotation.
Acceptance: the E2E suite passes on local CI in < 15 min; `pnpm test`, `go test ./...` and `buf breaking`
green.
