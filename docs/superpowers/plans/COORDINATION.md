# Coordinating plans in parallel

Plans 2–5 are written and executed **in parallel**, each on its own branch and
worktree (`feat/plan-N`, `.worktrees/plan-N`), starting from Plan 1's integrated branch.
Plans 6–8 go in a second wave, once 2–5 are merged; 9 closes. To make merges
mechanical, each plan only writes in its reserved ranges and anchors in the shared files.

| Wave | Plans | Base |
|---|---|---|
| A | 2 Metrics · 3 Configuration and templates · 4 Backups · 5 Files | Plan 1 integrated |
| B | 6 Import · 7 Migration · 8 mc-router | Wave A merged |
| C | 9 UI tests and polish | Wave B merged |

## Reserved ranges

| Plan | `Envelope.body` (field numbers) | Migrations (`name`) |
|---|---|---|
| 1 | 10–23 (used); 24–29 reserved for cross-cutting fixes (24 = `Event`, Plan 9) | `001_*`, `002_*` (used); `003_*`–`009_*` cross-cutting fixes |
| 2 Metrics | 30–39 | `010_*`–`019_*` |
| 3 Configuration and templates | 40–49 | `020_*`–`029_*` |
| 4 Backups (includes jobs) | 50–69 | `030_*`–`039_*` |
| 5 Files and transfers | 70–89 | `040_*`–`049_*` |
| 6 Import | 90–99 | `050_*`–`059_*` |
| 7 Migration | 100–109 | `060_*`–`069_*` |
| 8 mc-router | 110–119 | `070_*`–`079_*` |
| 9 Polish (StreamDropped, RotateToken, Settings) | 120–129 | `080_*`–`089_*` |

New protobuf messages (not the oneof's fields) carry names specific to their
area (`MetricBatch`, `BackupNow`, `FilesList`…) and are declared **at the end** of
`proto/mcsm/v1/agent.proto` inside their plan's comment block.

## Anchors

In each shared file there is one anchor comment per plan
(`// ── plan-N ──` or `-- plan-N` in SQL). A plan adds its lines **only below
its anchor**. Files with anchors:

- `proto/mcsm/v1/agent.proto`: oneof `body` and messages area.
- `panel/apps/api/src/db/migrations.ts`: `migrations` array.
- `panel/apps/api/src/app.ts`: plugin/route registration and decorations.
- `panel/apps/api/src/agents/service.ts`: dispatch of unsolicited agent messages.
- `agent/internal/app/app.go`: `Handle`'s `switch` and startup of background loops.
- `panel/apps/web/src/router.tsx`: route tree.
- `panel/apps/web/src/routes/server.tsx`: server detail tabs.
- `agent/internal/spec/spec.go` (struct `Spec`, `Validate`, `BuildContainer`) and
  `panel/packages/shared/src/spec.ts` (zod schema): new spec fields.

The anchors are created in a preparation commit right before launching the wave; when
writing a plan, assume they exist and say in each step "below the `plan-N` anchor".

## Area ownership (to avoid stepping on each other)

- **Plan 2** owns metrics: sampling in the agent, the `metric_samples` table,
  metrics endpoints, charts in the Overview and node cards.
- **Plan 3** owns the sectioned configuration form
  (`server-config-form.tsx` and whatever replaces it), the new-server wizard and
  templates. The spec fields `modpack`, `mods`, `plugins`, `whitelist`, `ops`.
  It does **not** create a Backups section in the form.
- **Plan 4** owns backups and jobs: spec field `backups`, the agent's `backup` package,
  the `backups`/`jobs` tables, `JobService`, the Backups and History tabs and the Jobs
  page. The backup schedule (cron, retention) is edited **in the Backups
  tab** (PATCH of `spec.backups`), not in Plan 3's form.
- **Plan 5** owns files and the HTTP transfers
  (`/agent/transfer/:id`, panel staging). Plan 4 does **not** implement backup
  download via transfer: it leaves the "Download" button for when Plan 5's mechanism
  exists (wave B wires it up). If Plan 4 needs something from Plan 5, it
  declares it as a dependency for wave B instead of duplicating it.
- None of them touches `panel/apps/api/src/auth/**` or the session guard.

## Generated code

`agent/gen/**` and `panel/packages/proto-ts/src/gen/**` are not merged by hand: after
each merge they are regenerated with `pnpm gen` and committed. `pnpm-lock.yaml`: after
merging, `pnpm install` and commit.

## After merging a wave

`buf lint`, `buf breaking --against` the base branch, the full verification from
`CLAUDE.md`, and a branch review with `final-reviewer`.
