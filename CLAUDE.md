# MC Server Manager

Self-hosted, single-administrator web manager for Minecraft Java servers running
`itzg/minecraft-server` on several LAN machines. A **panel**
(TypeScript: Fastify API + React web) and a Go **agent** per node that reconciles Docker
and connects to the panel over WebSocket with protobuf.

- Spec (authority): `docs/superpowers/specs/2026-10-12-mc-server-manager-design.md`
- Plans: `docs/superpowers/plans/README.md` (roadmap of plans 1–9) and one
  file per detailed plan (`2026-10-12-NN-<name>.md`).

## Structure

```
agent/            Go module mcsm/agent (cmd/agent, internal/*)
panel/            pnpm workspace: apps/api, apps/web, packages/shared, packages/proto-ts
proto/            .proto, single source of the protocol (buf)
deploy/           deployment docker-compose
website/          project site + docs (own pnpm project, GitHub Pages)
docs/             spec, plan, notes
.claude/agents/   project subagents (see "Agents")
```

## Commands

Toolchain: Go 1.27.2 and buf 1.73.0 via `mise` (run `eval "$(mise env)"` at the root
before `go`/`buf`); Node 26 and pnpm 12 global.

```bash
pnpm install                       # panel workspace dependencies
pnpm gen                           # buf generate → agent/gen and panel/packages/proto-ts/src/gen (committed)
pnpm lint:proto                    # buf lint
(cd agent && go build ./... && go vet ./... && go test ./...)
(cd agent && go test -race ./...)  # packages with goroutines
(cd agent && go test -tags integration ./...)   # against real Docker (slow)
pnpm typecheck && pnpm test        # all panel packages
pnpm --filter @mcsm/web build      # web build
pnpm dev:api                       # panel on :8080
pnpm dev:web                       # web on :5173 (proxy to :8080)
```

### Full verification (before closing a plan)

`eval "$(mise env)" && pnpm lint:proto && (cd agent && go vet ./... && go test -race ./...) && pnpm typecheck && pnpm test && pnpm --filter @mcsm/web build`

## Conventions

- Commits: conventional commits in English (`feat(agent): …`, `fix(panel): …`,
  `test(web): …`, `docs: …`), small. Final co-authorship line with the model that
  wrote the change: `Co-Authored-By: Claude Opus 5.5|Sonnet 5.5|Haiku 5.5
  <noreply@anthropic.com>` (replaces the `Claude Fable 5.1` one the plans carry).
  Never `git push`, never rewrite history, never `--no-verify`.
- TDD for anything with logic. Clean test output.
- Don't edit generated code (`buf generate`); it is regenerated.
- UI and error messages in English; code identifiers in English.
- Panel: TypeScript `strict`, ESM, `node:sqlite` with hand-written SQL (no ORM, no
  native dependencies), zod 4 shared in `panel/packages/shared`.
- Agent: external dependencies behind interfaces with fakes, `context` on all I/O,
  `slog`, injectable clock, clean `-race`.

## Docker on the development machine

There are containers on this machine that don't belong to the project. Tests and manual checks only
create/touch resources prefixed `mcsm-test-` or labelled `mcsm.test=true`, and clean
them up. `docker system prune`, mass deletions and touching other people's containers are forbidden.

## Agents

Defined in `.claude/agents/`. General rule: **Haiku** for the mechanical and for
summarizing, **Sonnet** for implementing and reviewing tasks, **Opus** for designing, debugging
the hard stuff, the concurrent, and the final and security reviews.

| Agent | Model | When |
|---|---|---|
| `architect` | Opus | Conflict rulings, unblocking BLOCKED, splitting tasks, protocol changes |
| `systems-expert` | Opus | Concurrency/streaming/distributed state (WS conn, reconciler, logs, transfers, backup/restore, migration, NodeRegistry); rescue in fix rounds 4-5 |
| `debugger` | Opus | Tests that fail for no obvious reason, flakiness, `-race`, integration/E2E |
| `final-reviewer` | Opus | Whole-branch review when closing a block or the plan |
| `security-auditor` | Opus | Auth, tokens, files, transfers, Docker socket; before deploying |
| `plan-writer` | Opus | Detailing plans 2–9 of the roadmap from the existing code |
| `go-agent-dev` | Sonnet | Agent Go tasks with clear requirements |
| `panel-api-dev` | Sonnet | Fastify API, SQLite, services, routes, WS, fake agent |
| `web-ui-dev` | Sonnet | React/shadcn/TanStack web |
| `infra-dev` | Sonnet | Dockerfiles, compose, buf, CI, real Docker integration, Playwright |
| `task-reviewer` | Sonnet | Per-task review (spec + quality) |
| `mechanical-dev` | Haiku | Tasks whose brief carries the complete code, scaffolding, config, codegen |
| `re-reviewer` | Haiku | Bounded re-review of small fixes |
| `test-runner` | Haiku | Run suites/lint/build and summarize failures |
| `docs-writer` | Haiku | README, deployment and usage guides |

### Workflow with the plan

It is run with `superpowers:subagent-driven-development`. For each task:

1. Choose the implementer: brief with complete code → `mechanical-dev`; Go →
   `go-agent-dev`; API → `panel-api-dev`; web → `web-ui-dev`; Docker/CI/E2E →
   `infra-dev`; concurrency, streaming or live protocol → `systems-expert`.
2. Review with `task-reviewer` (or `security-auditor` as well, if the task touches auth,
   tokens, files or transfers).
3. Fixes: rounds 1-3 resume the implementer; rounds 4-5 move to
   `systems-expert` or `debugger` (one level up). Re-review with `re-reviewer`
   if the fix is small, `task-reviewer` if not.
4. BLOCKED/NEEDS_CONTEXT or conflict with the spec → `architect`.
5. When closing each plan: `test-runner` with the full verification, `final-reviewer`
   (and `security-auditor` if the plan touched sensitive surface), merge the branch, and
   `plan-writer` details the next plan of the roadmap.

Independent tracks (e.g. Go agent and TS panel) can go in parallel, each in
its own worktree under `.worktrees/` (ignored by git) and with disjoint file
sets; never two implementers at once on the same working tree.

## Learned notes

(The controller adds here library pitfalls and decisions that agents must
know.)

- Plan 1 versions that don't exist on npm: `vitest ^4.3.0` → use `^4.1.11`;
  `@fastify/static ^8.4.0` → use `^8.3.0`. The rest of the plan's versions exist.
- Fastify: decorate services/repos (`app.nodes`, `app.servers`, `app.agents`,
  `app.events`, `app.serversService`…) in `buildApp()` or with `fastify-plugin`; never
  inside an encapsulated plugin (they become invisible to the rest). Routes do go
  encapsulated. HTTP errors: throw `HttpError` (`panel/apps/api/src/lib/http.ts`; also
  re-exported from `servers/service.ts`) and let the global handler (registered in
  `buildApp`) respond `{ error: "message in English" }`: generic 5xx ("Internal error")
  except 502/504; ZodError → 400; an `AgentError` is translated with `agentErrorToHttp` (502 with
  the agent/Docker text, spec §10). No need for your own `setErrorHandler`.
- Agent `Error.code` codes: catalog in the comment of `message Error`
  (`agent.proto`), constants in `agent/internal/errcode` and
  `panel/apps/api/src/agents/error-codes.ts`; a new code goes in all three places and, if it is not
  502, in the `agentErrorToHttp` table. The agent responds `unsupported` to bodies it doesn't
  know and never replies to an Ack/Error.
- `AgentConn.ready`: no request goes out to the agent before the `SyncSpecs` Ack;
  `request`/`openStream` wait on their own (expired deadline held → `syncing`, 409). The agent
  acknowledges `SyncSpecs` after saving to the store and reconciles in the background.
- Session guard: decides by the routed route (`req.routeOptions.url`), not by
  `req.url` (percent-encoded paths used to skip auth). Exact public allowlist.
- `@fastify/websocket` is registered only once in the whole app (before `authPlugin`).
- Migrations: never edit an applied one; add a new one to the array (they are applied by
  name, in array order).
- Agent↔panel protocol: only `ack`/`error`/`commandResult` with `id≠0` resolve
  panel requests; unsolicited agent messages go with `id=0`.
  `AgentConn.request/openStream` fail immediately with `AgentError("disconnected")`.
  `openStream` registers the stream before requesting it.
- Agent: use `rec.Apply(ctx, spec)` (version guard + PutSpec + Reconcile under the
  per-server lock), never PutSpec+Reconcile by hand; `rec.Remove` deletes the spec
  inside the lock. The reconciler's observer is invoked with the lock held: don't
  re-enter. RCON with our own Source client (`internal/mc`), not `mcutil/rcon`.
- Agent: operations that mutate Docker or disk use the agent's lifetime context
  (`App.life`), not the `ctx` of the WS session that receives `Handle`; the session's is only
  for log streams and RCON commands whose result goes to that session; transfers
  (which write to disk) use `App.life`. `send` stays tied to the session.
- Agent: `Power` only persists the desired state if the Docker action succeeds. The
  `Hello` carries `spec_versions` and `desired_states`; the panel resends in `SyncSpecs` whatever
  differs in either of the two (`specDiffers`).
- `BuildContainer` and `mcsm.spec_hash`: changing its output recreates **all** containers
  when the agent is updated. The hash is computed over `hashInput` (own canonical form +
  `hashSchema`); whatever is added to the container must enter `hashInput`, and new spec
  fields must leave the hash unchanged when empty (`omitempty`, nothing in the
  env). `TestHashGolden` pins the fixture's hash. Containers with `CapDrop ALL` + the
  itzg minimum, `no-new-privileges`, `PidsLimit` 4096 and memory `memory + 1G` without
  `memLimit`.
- Web: every API route with values is built with `apiPath` (`lib/api.ts`), which
  encodes each value: ``api.get(apiPath`/api/servers/${id}`)``.
- Docker fake (`internal/docker/fake.go`): real semantics (ports are bound at
  Start; Kill on a stopped container = conflict). Keep `CreateErr`, `Calls`, `Pulled`.
- Browser WS: `log_reset {serverId}` precedes the line backlog on (re)open
  (the console is cleared), `log_dropped {serverId,count}`, `error {message}`,
  `stream_closed`. The web invalidates its queries in `realtime.onReconnect`.
- Web: shadcn is used with `pnpm dlx shadcn@3.8.5` (Radix variant), never `@latest`.
  `cn` = clsx + tailwind-merge. Tests with vitest (`pnpm --filter @mcsm/web test`).
- Spec validation (Go and zod identical): env names `^[A-Za-z_][A-Za-z0-9_]*$`
  and reserved ones; memory `^[1-9]\d*[MmGg]$`; extra ports without container 25575;
  properties with key `^[a-z0-9][a-z0-9._-]*$`, without line breaks and without
  `server-port`/`enable-rcon`/`rcon.port`/`rcon.password`; `imageTag`
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, `latest` by default. Repeated autogenerated slug
  → suffix `-2`, `-3`…
- Tests without `time.Sleep`/`setTimeout` to synchronize: injectable clocks and
  schedulers.
- Web: the panel is served over HTTP on the LAN (no secure context): no
  `crypto.randomUUID()` or APIs that require HTTPS without a fallback; ids with
  `crypto.getRandomValues`.

- Spec PATCH = first-level merge: `null` only deletes optional sections; `null` on a
  required key is 400. An absent section ≠ present and empty (`[]` emits SYNCHRONIZE).
  A present section (ops/whitelist) forbids in `env` the variables it generates.
- Spec caps equal in Go and zod (lists ≤ 1000, strings ≤ 4 KiB, URLs ≤ 2 KiB) and
  serialized spec ≤ 64 KiB in the panel after the merge. Go/zod divergences only in the
  safe direction (zod equal or stricter) and with a shared fixture in `proto/fixtures/`.
- `toServerSpecMessage(row, curseforgeApiKey)`: the key is mandatory in every emitter of
  `ApplySpec`/`SyncSpecs` (if missing, CurseForge servers get recreated in a loop).
- Web: a `<form>` inside a dialog nested in another form calls `stopPropagation`
  on its submit (React propagates through the tree even if the dialog is in a portal).
- `routes/server.tsx` has TWO anchors per plan: the first (inside `<TabsList>`) only
  for `TabsTrigger`; the second (after `</TabsList>` and the last `TabsContent`) for
  `TabsContent`. Check with `grep -n` that no `TabsContent` ends up inside `TabsList`.
- Web: vitest runs in node without jsdom; UI logic goes in pure functions with tests. Caches
  with `mergeIntoCached` and, when resyncing forms, don't overwrite unsaved edits
  (pure decision with a test, `shouldResyncNumber` pattern).
- Clocks: the panel accepts the agent's `ts` within ±45 s (`MAX_CLOCK_SKEW_SECONDS` in shared);
  freshness in the web is measured with the local arrival time.
- Cron: only printable ASCII and space/tab, the same in Go and zod (fixture `cron-cases.json`).
- E2E with Docker on this machine: nftables drops container → host, so everything runs in
  containers. `bash deploy/e2e/run.sh` (project `mcsm-test-e2e`, panel on 18080, game ports
  26600–26620, node B in `docker:dind` joined to the servers' network, Playwright
  in its own container) runs the `panel/apps/e2e` suite and leaves screenshots in
  `panel/apps/e2e/screenshots/` (that is how visual checks are done: Claude in Chrome can't
  open `localhost:8080`). This is the development machine (production runs elsewhere), but it
  has the user's own local deployment (`mcsm-panel-1`, `mcsm-agent-1`, `mcsm-agent`, network
  `mcsm`, volumes `mcsm_*`, ports 8080 and 25565–25600) that tests must not touch: compare
  `docker ps -a`/`network ls`/`volume ls` before and after any test.
- After every merge look for duplicates git doesn't flag: repeated YAML keys (`docker compose
  config`), repeated flags in snippets, same-named `var`/`const` in a Go package, duplicated
  tests; and compare `pnpm gen` with what is committed.
- Files (`Files*`) that write respond `busy` if `rec.Held(id)`. `fileWrites` protocol:
  the mutation does `enter` before looking at `Held`; the restore does `Hold` before
  `drained` (≤ 10 s, if it doesn't drain → busy). Every new operation that writes to `data`
  (import, migration) uses the same counter and the same check.
- Backups: upload temporaries (`files.TempGlob` = `.mcsm-tmp-` + 16 hex, `files.IsTempName`)
  are always excluded, even with a nil `Excluder`; a user's `.mcsm-tmp-x` is normal. Every spec section changes via `serversService.patch` (e.g. the schedule is
  `patch(id, {spec:{backups}})`), never `servers.updateSpec` directly from another service.
- Agent shutdown: waits in parallel with `waitAll`, total ≤ 25 s against
  `stop_grace_period: 30s` / `--stop-timeout 30`; a new wait goes into `waitAll`.
- Backup notices (`BackupCreated`/`BackupDeleted`/inventory) go through the FIFO `outbox`, not
  through the session's `send`; what is queued may arrive after the next `Hello`: don't
  interpret an unsolicited message with the current session's state without correlating it.
  The panel applies the inventory's negative path (deleted/lost) only if
  `BackupInventory.request_id` matches its last `BackupList` for the node and to rows with
  `created_at < since`; the periodic one (0) or an old one only applies the positive. The panel's
  envelope ids come from `AgentHub.allocateId` (not repeated across sessions); to
  correlate, `conn.requestTracked`.
- Reservation and jobs: at most 2 backups/restores per node (`withSlot`, before
  `save-off`/`Stop`); while they wait, the server stays reserved (Power 409, Files busy).
  Docker probes in dangerous operations with `rec.Container` (returns an error), never
  `ContainerID`.
  `reconcile.ErrBusy` is neutral (“server busy or reserved”): wrap it with
  `reconcile.Busy(reason)`; `rec.HeldReason(id)` gives the reservation's reason.
- Space: whatever writes a lot on the node (backups, restores, import, migration)
  requires estimate + `max(5 %, 256 MiB)` free and watches during the write.
- Chained caps: `maxPayload` 4 MiB ↔ inventory 3 MiB ↔ agent `readLimit` 4 MiB ↔
  spec 64 KiB ↔ `FilesReadResult` 2 MiB. If one changes, review the others.
- Templates: `templateSpecSchema = {...baseFields}`; every new section travels in templates
  unless excluded in `specToTemplate` (`dataPath` lives outside `baseFields`).
- Web: the content of each server tab carries `key={s.id}`; every form with
  dirty state registers `useTabGuard` (and `useBlocker`); dialogs with `<form>` use
  `dialogSubmit`.
- Full verification: add `buf breaking --against ".git#ref=main"` (works in
  worktrees) and `go vet -tags integration ./...`.
- Docker 29.7.2: after a `start` that failed because of the port, the next one starts **without publishing
  ports** (even if it is stopped and started again). Hence `startOrDiscard` (start,
  check `Inspect.PortsMissing` and, if it fails, delete to recreate; never an `Adopted` one) and the
  fake reproduces it. Every new `Start` of a server goes through `startOrDiscard`.
- mc-router with autoscale starts and stops containers on its own and **ignores `Hold`**: whatever
  reserves an on-demand server (restore, cold backup, lock) parks it with
  `rec.Park`. mc-router **doesn't wake containers that never started**: a newly
  created or recreated on-demand one is started (it puts it to sleep); that is why an on-demand one isn't migrated
  (Park + release would start it on the source).
- Router: own hash in `mcsm.router_hash` (doesn't touch `mcsm.spec_hash`) and image pinned by
  digest (`router.ImageRef()`); bumping the version = new tag + digest.
- Logs of containers without a TTY (adopted imports): Docker multiplexes them; `Moby.Logs` looks at
  `Config.Tty` and separates them with `stdcopy` (`demuxLogs`).
- E2E with `docker:dind`: it mounts its tmpfs on `/tmp` and hides binds of paths under `/tmp`; use
  `deploy/data` for the dind nodes' `DATA_ROOT`.
- After every merge, also `go vet -tags integration ./...` (integration tests don't
  compile under plain `go vet` and duplicates show up there).
- Hot backups: `CreateRequest.Running` mandatory (same container ID and `StartedAt`
  when closing the tar and before the `.json`); a file that changes while being read →
  `ErrSourceChanged`; a failed backup (also with a failed `save-on`) never leaves a file nor is
  announced. Known residual window: a stop that begins during the tar with Minecraft still
  saving in both checks (for on-demand servers, prefer cold backups).
- Crash loops (§10): the agent's engine is wrapped (`crashloop.Engine`) and every
  Stop/Kill/Remove, and every stop the proxy lets mc-router do, records in
  `crashloop.Intents` an intent that absorbs ONE `die` of that container (3 min). Counted are the
  `die` with exit ≠ 0 that were not requested and have no reservation; >3 in 1 h → `CrashLoopStop` latches (bucket
  `crash_latch`, tied to the version) until Power start/restart or a new version; `StartGen`
  discards queued stops after a Start or a new version. The panel sets the desired state to
  stopped if the `crash_loop`'s `ts` is later than `servers.desired_changed_at` (every change of
  `desired_state` updates that column).
- `Event` (Envelope 24) is unsolicited (id = 0) and goes out through the `App.events` queue (outbox): without a
  connection it is lost; the important part also stays in `Observed.error`. Kinds in `agent.proto`;
  the panel adds `token_rotated`. Envelope 24/120/121 and migrations 080–083 are already used.
- mc-router never receives the Docker socket: it mounts read-only the DIRECTORY
  `<DATA_ROOT>/.mcsm-router/` and talks to the agent's filtered socket (`dockerproxy`: only
  containers with `mc-router.host`, no bodies, API ≥ 1.24, start/stop by `routerPolicy`) and
  reconnects on its own if the agent restarts. Touching the router's binds/cmd changes
  `mcsm.router_hash` (it is recreated once on update).
- Panel: writes under `/api/` with a foreign `Origin` → 403 (without `Origin` they pass: agent, curl).
  Public URL and port range come from `app.settings` (`SettingsService`), never from
  `config.publicUrl`/`config.gamePortRange`. Changing the password deletes all sessions,
  issues a new cookie and closes their WS with 4401 (the web uses `expectSessionChange` and
  `holdUnauthorized` during the mutation). Token rotation: pending hash stored before
  sending `RotateToken`, promoted on the first connection with it.
- Agent time: rows (jobs, events) are created with the PANEL's time; the agent's only
  in `started_at`/`finished_at`/`agentAt`, sanitized with `lib/time.ts`.
- Pending save-on: background retry with `rec.TryHold` (never waits for the lock), RCON
  ≤ 5 s and backoff 30 s → 5 min.
- `build` (plan 10): itzg variable per type (`BUILD_ENV` in shared, `buildEnvKeys` in Go; Folia is
  `FOLIABUILD`, no underscore). Empty emits nothing (hash intact); with a value it requires a type with build and
  a concrete version, and forbids its variable in `env` (fixture `build-cases.json`). The web doesn't add `build`
  to old specs that don't have it (no phantom diff).
- Version lists: `app.versions` (`VersionCatalog`, `api/src/versions/`) queries the official
  sources with an in-memory cache (lists 1 h, builds 15 min, stale if the source goes down); tests inject
  `fetch` and never touch the network. New source = adapter in `versions/sources.ts` + host in
  `allowedSource`. Only STABLE builds of Paper/Folia (experimental ones require `*_CHANNEL`).
- CI and releases: `.github/workflows/ci.yml` (push to main, PR and `workflow_call`) and `release.yml` (when publishing a
  Release; the tag must be `v<agent/VERSION>` or it fails). Publishes `ghcr.io/javilobo8/mcsm-{panel,agent}` for amd64 and
  arm64 on native runners (push-by-digest + `imagetools create`). Actions pinned by SHA with `# vX.Y.Z`; multi-arch
  base images (an amd64-only digest breaks arm64). The panel image pins `MCSM_AGENT_IMAGE`
  (build-arg `AGENT_IMAGE`) to the agent of its version; `config.agentImage` goes in the `docker run` from “Add node”.
- The `deploy/` composes use the GHCR images (`MCSM_VERSION`, empty = latest); building from source =
  add `-f deploy/docker-compose.build.yml` (the E2E does). The local deployment on this machine is updated
  with that override until a published release exists.
- Go tests that start the event loop: `runEventLoop(t, a)`, never `go a.eventLoop(ctx)` (it must exit before the
  `bg.Wait` of `newApp`'s cleanup, or `-race` trips). CI runs on 4-CPU runners: a test that depends on
  the scheduler letting another goroutine run fails; try it with `GOMAXPROCS=1`.
- The README (“Deployment”) carries literal copies of `deploy/docker-compose.yml`, `deploy/docker-compose.node.yml` and of the
  `docker run` from `dockerRunSnippet`: if they change, update the README (and its example `.env` files).
- Website (`website/`): its own pnpm project (own `pnpm-workspace.yaml` and lockfile; not in the root workspace, so
  root `pnpm typecheck/test` and the panel image ignore it): `cd website && pnpm install && pnpm test && pnpm build`.
  Deployed by `.github/workflows/pages.yml` (push to main touching `website/**` or the included `deploy/` files, and
  after each successful Release so the version badge follows `agent/VERSION`). Docs are Markdown in
  `website/src/content/docs/` under the contract in `docs/superpowers/specs/2026-10-14-website-design.md` §5.2; the
  content test fails on dead links/anchors/images. The composes and `.env.example` are included at build time
  (`include="deploy/…"`), but `adding-nodes.md` and `components/landing/quick-start.tsx` carry copies of the
  `docker run` from `dockerRunSnippet`: update them with the README. Visual check: `pnpm build && bash
  scripts/screenshots.sh` (Playwright container `mcsm-test-site-shots`, PNGs in `website/screenshots/`).
- Panel look = website look: the palette tokens (`:root` of `panel/apps/web/src/index.css` ↔ `website/src/index.css`),
  the grass-block logo (`components/logo.tsx` in both, `favicon.svg`) and `hash01` (login sky/ground) are copies: change
  them together. Web UI: status colours only through the tones (`text-ok|warn|bad|info`, `StatusBadge`/`TONE_*` in
  `components/status.tsx`), never Tailwind palette classes (`red-400`, `zinc-500`…); chart series from
  `components/chart-colors.ts`; every page root is `PAGE` + `PageHeader` (`components/page-header.tsx`, pixel-font h1),
  block headings `SectionTitle` (sentence case, no uppercase labels). Filled buttons are notched blocks (`.block-btn`
  + `block-grass|stone|redstone` in index.css), `outline` is bordered like the inputs; `Table` brings its own frame;
  tabs nested in a tab use `TabsList variant="pill"`. Fonts are bundled with
  `@fontsource-variable` (the panel works offline on the LAN). After changing the panel's look, refresh the website's
  screenshots (`website/public/screenshots/*.webp`, from the E2E PNGs) and `og-image.png` (`scripts/og-image.sh`).
