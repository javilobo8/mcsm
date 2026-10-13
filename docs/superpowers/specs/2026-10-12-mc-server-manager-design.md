# MC Server Manager — Design

Date: 2026-10-12
Status: draft approved in conversation, pending written review

## 1. Goal

A self-hosted, single-user (administrator) application to manage from an internal web UI
all the Minecraft Java servers running the `itzg/minecraft-server` image on several
machines of the home LAN.

It must allow, without ever touching the command line:

- Create, edit, start, stop, restart and delete servers on any node.
- Configure absolutely everything the itzg image allows (type, version, mods,
  modpacks, memory, properties, whitelist, ops, ports, etc.).
- See status, connected players, CPU/RAM usage and charts for the last 7 days.
- See live logs and send console commands.
- Browse and edit the server's files.
- Make, schedule, restore and download backups.
- Save templates, clone servers, migrate servers between nodes.
- Enroll new nodes with a token, import existing itzg servers.
- Optionally deploy `mc-router` to join by hostname.

Out of scope (YAGNI): multi-user and permissions, access from the Internet, Bedrock,
Kubernetes/Swarm, Prometheus/Grafana, cloud backups. The design doesn't prevent them, but
they are not built.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Topology | Panel and nodes on the same LAN. No public TLS. The agent initiates the connection. |
| Stack | Agent in Go. Panel (API + web) in TypeScript on Node 26 and pnpm. |
| Agent model | Reconciler: the panel sends desired specs, the agent reconciles Docker and reports the real state. |
| Agent installation | Docker container with `/var/run/docker.sock` mounted. |
| Panel database | SQLite (a single file) via Node 26's native `node:sqlite` module, hand-written SQL and numbered SQL migrations. No ORM or native dependencies. |
| Agent local store | bbolt (single file) in a volume of the agent's container. |
| Protocol | Protobuf defined with `buf`, binary over one WebSocket per agent. Outbound HTTP from the agent for large transfers. |
| Backups | Native in the agent (RCON save-off/save-all, tar.zst, save-on). Destination: the node's local disk. |
| Migration | Backup on the source → transfer via the panel → restore on the target → verification → deletion on the source. |
| Existing servers | Assisted import: the agent detects unmanaged itzg containers and the panel proposes a spec. |
| Player network | One port per server; optional `mc-router` deployable per node. |
| Metrics | Live + 7-day history in SQLite. No Prometheus. |
| Files | Full manager confined to each server's data directory. |
| Web authentication | A single administrator password, cookie session. |

## 3. Architecture

```
┌─────────────────────────── Main machine ────────────────────────────────┐
│  panel (container)                                                       │
│   ├─ HTTP API (Fastify)        ← browser (REST + WS)                     │
│   ├─ WS /agent  (protobuf)     ← agents (each node's outbound connection)│
│   ├─ HTTP /agent/transfer      ← agents (streaming upload/download)      │
│   ├─ SQLite  (/data/panel.db)                                            │
│   └─ Static web (React)                                                  │
│  agent (container)  ── docker.sock ── the node's itzg containers         │
└──────────────────────────────────────────────────────────────────────────┘
┌──────── Node B ────────┐   ┌──────── Node C ────────┐
│ agent ── docker.sock   │   │ agent ── docker.sock   │
│   └─ itzg x N          │   │   └─ itzg x N          │
└────────────────────────┘   └────────────────────────┘
```

- The panel is the **single source of truth** for configuration. The agent keeps a
  copy of its node's specs only so it can work without the panel (reconcile, run
  scheduled backups, restart). That copy is always overwritten with whatever the
  panel says on reconnect.
- Each node has **one agent** and only one. The agent manages only the
  containers that carry its labels (`mcsm.managed=true`, `mcsm.server_id=<uuid>`).
- The agent **never listens** on the network. All traffic is outbound to the panel.
- The main machine also runs an agent so it can manage its own
  servers with the same mechanism as the rest.

### 3.1 Repository structure (monorepo)

```
mc-server-manager/
├─ agent/                    Go module `mcsm/agent`
│  ├─ cmd/agent/             main
│  ├─ internal/
│  │  ├─ conn/               WebSocket client, reconnection, stream multiplexing
│  │  ├─ store/              bbolt: credentials, specs, backup state
│  │  ├─ docker/             Docker SDK wrapper (interface + impl + fake)
│  │  ├─ reconcile/          spec↔container reconciliation loop
│  │  ├─ mc/                 status ping (SLP) and RCON client
│  │  ├─ logs/               log following and fan-out to subscribers
│  │  ├─ stats/              container and host stats sampling
│  │  ├─ files/              confined file operations
│  │  ├─ backup/             create, list, restore, schedule, prune
│  │  ├─ importer/           detection of unmanaged itzg containers
│  │  └─ jobs/               long-job execution with progress
│  └─ Dockerfile
├─ panel/
│  ├─ apps/api/              Fastify + Drizzle + WS; serves the web in production
│  ├─ apps/web/              React + Vite + Tailwind + shadcn/ui + TanStack Query/Router
│  └─ packages/proto-ts/     TS types generated by buf
├─ proto/                    .proto files (single source of the protocol)
├─ buf.yaml, buf.gen.yaml
├─ deploy/
│  └─ docker-compose.yml     panel + local agent
├─ docs/superpowers/specs/
└─ README.md
```

## 4. Data model (panel, SQLite)

All tables use a UUIDv7 `id` as text, `created_at`/`updated_at` in ISO 8601.

**nodes**
- `name`, `token_hash` (SHA-256 of the permanent token), `data_root` (e.g. `/srv/minecraft`,
  path on the node's host), `agent_version`, `docker_version`, `last_seen_at`,
  `status` (`online|offline|degraded`), `host_info` JSON (CPUs, total RAM, total disk
  of `data_root`), `settings` JSON (allowed port range, stats interval).

**enrollment_tokens**
- `token_hash`, `node_name_hint`, `expires_at` (15 min), `used_at`. Single use.

**servers**
- `node_id`, `name`, `slug` (unique per node, used in the data path and container
  name `mcsm-<slug>`), `spec` JSON (see 4.1), `spec_version` (integer, +1 per
  change), `desired_state` (`running|stopped`), `observed` JSON (last reported state:
  container_id, state, health, uptime, detected MC version, players, reconciliation
  error if any), `observed_spec_version` (which version the agent has already applied),
  `imported_from` JSON nullable (name and id of the original container).

**templates**
- `name`, `description`, `spec` JSON (same shape as servers.spec but without ports or
  rcon_password; the panel fills them in when instantiating), `source_server_id` nullable.

**backups**
- `server_id`, `node_id`, `filename`, `size_bytes`, `sha256`, `spec_version`,
  `trigger` (`manual|scheduled|pre_migration|pre_restore`), `status`
  (`running|ok|failed|deleted`), `started_at`, `finished_at`, `error`.

**jobs**
- `type` (`create_server|apply_spec|backup|restore|migrate|import|...`; the router is not a
  job: see `router_deployments`),
  `server_id` nullable, `node_id`, `status` (`queued|running|ok|failed|cancelled`),
  `progress` (0-100), `message`, `log` (accumulated text), `payload` JSON,
  `started_at`, `finished_at`.

**metric_samples**
- `scope` (`server|node`), `scope_id`, `ts` (epoch seconds, rounded to 10 s),
  `cpu_pct`, `mem_bytes`, `mem_limit_bytes`, `net_rx_bytes`, `net_tx_bytes`,
  `disk_bytes` (node only), `players_online`, `players_max`, `tps` nullable
  (if the server exposes it via RCON on Paper/Purpur), `ping_ms`.
- Index `(scope, scope_id, ts)`. Retention: 7 days at 10 s. It is not aggregated in the DB;
  the API aggregates on the fly per minute/5 min depending on the requested range. With ~10 servers
  that is about 600k rows, manageable in SQLite.

**settings** (key/value): admin password hash, session secret, the panel URL that is
embedded in the enrollment command, optional CurseForge API key (global, injected
as `CF_API_KEY` into servers that ask for it), UI preferences.

**router_deployments** (mc-router per node; implemented in Plan 8)
- `node_id` (key, cascade-deleted with the node), `spec` JSON
  `{enabled, port (25565), autoscale, autoscaleDownAfterMinutes (1-1440, 10), autoscaleAllowPlayers: [name|UUID] (≤ 1000)}`,
  `observed` JSON (last `RouterObserved`: configured, state, container, image, port,
  autoscale, error and the spec the agent has), `observed_at`, `updated_at`.
- No “default backend” or additional mappings: each server is entered through **one** hostname from its
  spec (4.1). No row = router not configured (disabled).
- Autoscale is **per node**, not per server: with it, mc-router starts when a player joins
  and stops after the minutes without players **all** the node's servers with an active hostname
  (“on-demand”). `autoscaleAllowPlayers` limits who wakes them
  (`-auto-scale-allow-deny`); empty = anyone who reaches the port.

### 4.1 Shape of a server's `spec`

```jsonc
{
  "image": "itzg/minecraft-server",
  "imageTag": "java21",                 // java8 | java17 | java21 | java25 | latest
  "type": "PAPER",                      // VANILLA, PAPER, PURPUR, SPIGOT, FABRIC, FORGE, NEOFORGE, QUILT, ... or AUTO_CURSEFORGE/MODRINTH via modpack
  "version": "1.21.4",                  // or LATEST / SNAPSHOT
  "build": "",                          // plan 10: build/loader → PAPER_BUILD, FOLIABUILD, PURPUR_BUILD, FABRIC_LOADER_VERSION, QUILT_LOADER_VERSION, FORGE_VERSION or NEOFORGE_VERSION depending on the type; empty = the latest
  "memory": "4G",
  "modpack": {                          // optional
    "platform": "MODRINTH" | "AUTO_CURSEFORGE" | "FTBA",
    "slugOrUrl": "...", "versionId": "...", "loader": "fabric"
  },
  "mods": { "modrinthProjects": ["lithium", "ferritecore:beta"], "curseforgeFiles": [], "urls": [] },
  "plugins": { "modrinthProjects": [], "spigetResources": [], "urls": [] },
  "properties": { "motd": "...", "difficulty": "normal", "max-players": 10, ... },  // → server.properties via itzg env
  "whitelist": { "enabled": true, "players": ["Lobo"] },
  "ops": ["Lobo"],
  "env": { "USE_AIKAR_FLAGS": "true", "ENABLE_AUTOPAUSE": "false" },  // free extras, win over what is generated
  "ports": { "game": 25565, "extra": [ { "host": 19132, "container": 19132, "proto": "udp", "label": "Geyser" } ] },
  "resources": { "cpus": 2.0, "memLimit": "5G" },   // Docker limits; memLimit >= memory + 1G by default
  "restartPolicy": "unless-stopped",
  "rconPassword": "<generated by the panel>",        // RCON is never published on the host
  "backups": { "enabled": true, "cron": "0 4 * * *", "keepDays": 7, "keepCount": 10, "excludes": ["*.jar","cache","logs","*.tmp"], "onlyIfPlayersSince": true },
  "router": { "enabled": true, "hostname": "survival.lan" }   // optional; one hostname per server (RFC 1123, lowercase)
}
```

The **agent** transforms the spec into a deterministic `ContainerConfig` + `HostConfig`:
name `mcsm-<slug>`, `mcsm.*` labels, bind `<data_root>/<slug>/data:/data`, generated
env (TYPE, VERSION, the type's `build` variable, MEMORY, EULA=TRUE, RCON_PASSWORD, MODRINTH_PROJECTS…,
properties mapped to their itzg variables), ports, limits, restart policy, and
labels `mc-router.host=<hostname>` and `mc-router.network=<agent's network>` only if
`router.enabled` (without a section, or disabled, the container and its hash don't change). The function
is pure and is tested with case tables. A hash of that result is stored in the label
`mcsm.spec_hash` to detect drift without comparing field by field.

`router` (Plan 8): the hostname is unique per node among servers with the router active
(counting open migrations towards that node) and the panel validates it with the same regex as
the agent (fixture `router-hostname-cases.json`). Each server keeps its own port. Templates
don't carry `router` and import doesn't adopt it either: it is enabled afterwards in
Configuration → Network (an adopted one has no labels until it is recreated).

## 5. Panel ↔ agent protocol

### 5.1 Transport

- One WebSocket per agent: `GET /agent/ws` with header `Authorization: Bearer <node token>`.
  Binary protobuf messages. Ping/pong every 15 s; considered down at 45 s.
- Agent reconnection with exponential backoff 1 s → 30 s with jitter.
- Large transfers over the agent's outbound HTTP with the same token:
  - `PUT /agent/transfer/{transferId}` streaming body (upload of a backup or file to the panel).
  - `GET /agent/transfer/{transferId}` streaming download.
  - The panel uses a *staging* directory for transfers; files that users upload
    from the browser go browser → panel → agent (streaming, without
    saving to disk when possible).

### 5.2 Envelope

```proto
message Envelope {
  uint64 id = 1;            // request id; responses repeat it
  uint64 stream_id = 2;     // 0 if not a stream
  oneof body { ...messages... }
}
```

Kinds of exchange:
- **Request/Response**: new `id`, one response with the same `id`, or `Error{code, message}`.
- **Stream**: whoever opens indicates `stream_id`; frames carry that `stream_id`;
  `StreamClose{stream_id, reason}` closes in either direction. Simple flow
  control: the agent drops log frames if the output buffer exceeds 1 MiB and
  sends `StreamDropped{count}`.

### 5.3 Main messages

Agent → panel:
- `Hello{agent_version, docker_version, host_info, spec_versions: map<server_id, version>}` on connecting.
- `Enroll{enrollment_token, name_hint}` → `EnrollResult{node_token, node_id}` (first time only, via HTTP `POST /agent/enroll`, not over WS).
- `ServerObserved{server_id, observed}` whenever the real state changes (Docker events) and, at a minimum, every 30 s.
- `MetricSample{...}` every 10 s per server and per node (in a single grouped message).
- `JobProgress{job_id, progress, message, log_chunk, status}`.
- `BackupCreated{...}`, `BackupDeleted{...}` for scheduled backups without panel intervention.
- `Event{level, server_id?, kind, message, ts}` for incidents (`crash`, `oom`, `crash_loop`, `crash_loop_failed`,
  `drift`, `save_on_pending`, `save_on_resumed`). There is no subscription: the agent sends them unsolicited (id = 0) through
  its own queue; without a connection they are lost (the important part also stays in `observed.error`).

Panel → agent:
- `SyncSpecs{servers: [ServerSpec{server_id, slug, version, desired_state, spec}], removed_ids}` after `Hello`, with only what differs, and then `ApplySpec{...}` for each change.
- `PowerAction{server_id, action: start|stop|restart|kill}`.
- `SendCommand{server_id, command}` → `CommandResult{output}` (RCON).
- `SubscribeLogs{server_id, tail}` → stream `LogLine{ts, line}`.
- `Files*`: `List`, `Stat`, `Read{path, max_bytes}`, `Write{path, content}`, `Mkdir`,
  `Rename`, `Delete`, `Download{path} → transfer_id`, `Upload{path, transfer_id}`.
- `BackupNow{server_id, job_id}`, `BackupList{server_id}`, `BackupRestore{server_id, backup_id, job_id}`,
  `BackupDelete`, `BackupPush{backup_id, transfer_id}` (uploads to the panel), `BackupPull{transfer_id, server_id}` (downloads from the panel to the node).
- `ImportScan{}` → `ImportCandidates{[container_id, name, env, ports, mounts, image]}`;
  `ImportAdopt{container_id, server_id, slug}`.
- `RouterApply{spec}` / `RouterRemove{}` (the agent responds with `RouterObserved`, unsolicited,
  after each router reconciliation).
- `PullImage{ref, job_id}`.

### 5.4 Idempotency and versions

- Every mutating operation carries a `job_id` or a `spec_version`. The agent stores in
  bbolt the last `spec_version` applied per server and the state of every known
  `job_id`; if it receives a duplicate, it responds with the stored result.
- The panel never assumes success: the UI shows the desired `spec_version` vs `observed_spec_version`
  and marks “applying…” while they differ.

## 6. The agent in detail

### 6.1 Startup

1. Reads config from env: `PANEL_URL`, `ENROLL_TOKEN` (first time only), `DATA_ROOT`
   (host path, e.g. `/srv/minecraft`), `AGENT_DATA=/var/lib/mcsm-agent`.
2. If there is no token in bbolt, it does `POST /agent/enroll`; stores `node_token` and `node_id`.
3. Opens the WS, sends `Hello` with the spec versions it has.
4. Starts in parallel: reconciler, Docker event watcher, stats sampler,
   backup scheduler, log manager.

Mounts of the agent's container: `/var/run/docker.sock`, `<DATA_ROOT>:<DATA_ROOT>`
(same path inside and outside so the binds it creates match what it sees), a
volume for `AGENT_DATA`, and `/proc:/host/proc:ro` with `HOST_PROC=/host/proc` for
host metrics with gopsutil.

### 6.2 Reconciliation

Loop triggered by: spec change, relevant Docker event (`die`, `start`, `destroy`,
`health_status`), and a tick every 30 s. For each server:

1. Look for the container by label `mcsm.server_id`.
2. It doesn't exist and `desired_state=running|stopped` → create the data directory (if it
   doesn't exist), `docker pull` if the image is missing, create the container; start it if `running`.
3. It exists with a different `spec_hash` → clean stop (`stop` with a 60 s timeout, the itzg
   image does `save-all`/`stop` via RCON on receiving SIGTERM), `rm`, recreate, start
   if appropriate. The data isn't touched (it's in the bind).
4. It exists, same hash, but state ≠ desired → `start`/`stop`.
5. Report `ServerObserved`. If an action fails (port in use, nonexistent image,
   no space), store the error in `observed.error` and retry with backoff
   (at most every 5 min) until the spec changes.
   Docker 29.7.2: after a `start` that failed because of the port, the next one starts **without publishing
   ports**. Therefore a start that fails, or that leaves the container without its ports, deletes it
   (`startOrDiscard`; the data is in the bind) and the next pass recreates it (`Power` recreates it
   immediately); never the original container of an imported one (it is only reported). One
   running without its ports (started by something else: the restart policy, mc-router) is reported in
   `observed.error` and “Restart” recreates it.

Containers with `mcsm.*` labels that are in no spec are **stopped and
deleted** only if the panel included them in `removed_ids`; never on the agent's own
initiative, so that a corrupt store destroys nothing.

### 6.3 Logs and console

- One `docker logs --follow --tail N` per server, opened on demand at the first
  subscriber and closed 30 s after the last. In-memory fan-out to the subscribed
  `stream_id`s; circular buffer of the last 500 lines to serve the `tail` instantly.
- Commands via native RCON (small Go client, Source RCON protocol) against the
  container's internal IP on the Docker network and `RCON_PORT` 25575; it is not published on the host.

### 6.4 Metrics

Every 10 s: one-shot `docker stats` per managed container (CPU %, memory, network) and a
Server List Ping to the game port inside the Docker network (online/max/version/latency).
On Paper/Purpur, `tps` via RCON every 30 s. Host: CPU, RAM, usage of the disk where `DATA_ROOT`
lives. Grouped into one `MetricSample` per send.

### 6.5 Backups

- Format: `<slug>-<ISO ts>-<spec_version>.tar.zst` in `<DATA_ROOT>/<slug>/backups/`.
- Procedure: if the server is running, RCON `save-off`, `save-all flush`,
  wait 3 s; tar with exclusions; `save-on` (in `defer`, also if it fails); sha256;
  write a `.json` metadata file next to the tar. If the server is stopped, direct tar.
- Scheduling with the spec's cron expression, in the agent itself (`robfig/cron` library).
  `onlyIfPlayersSince`: skipped if nobody has connected since the last backup.
- Pruning after each backup according to `keepDays` and `keepCount`.
- Restore: stop the server, rename `data` to `data.pre-restore-<ts>` (kept
  as a safety net and recorded as a `pre_restore` backup), extract, start. The previous
  directory is never deleted automatically; the UI offers to delete it afterwards.

### 6.6 Files

Confined root: `<DATA_ROOT>/<slug>/data`. Every path is resolved with `filepath.Clean`
and the result is required to have the root as a prefix after resolving symlinks
(`filepath.EvalSymlinks`). 2 MiB limit for inline read/write; larger goes
through transfer. Writes are atomic (temporary file + rename).

### 6.7 Import

`ImportScan` lists containers whose image starts with `itzg/minecraft-server` and without the
`mcsm.managed` label. For each one it returns a reduced inspect. The panel generates a candidate
spec: env → known fields, the rest to `env`; port `25565/tcp` → `ports.game`;
`/data` bind → a `slug` is proposed and, if the bind is not under `DATA_ROOT`, the spec
stores an explicit `dataPath` (optional field that overrides the default path). On adopting,
the agent adds the labels by renaming the container to `mcsm-<slug>` only when
the user requests the first spec change; in the meantime it is managed by `imported_from.container_id`.

## 7. The panel in detail

- **Fastify 5** with `@fastify/websocket`, `@fastify/cookie` (signed session cookie pointing to a `sessions` row),
  `@fastify/static` for the compiled web. Input validation with **zod**; spec types
  are shared with the web from `packages/proto-ts` and a `packages/shared` package
  with the spec zod schemas and the function that validates combinations (e.g. `modpack`
  only with a compatible `type`).
- **Services**: `NodeRegistry` (active WS connections; no message queue for offline
  nodes: the 2026-10-12 amendment replaces it with `SyncSpecs` on reconnect, which
  delivers the version and desired state of each server), `SpecService` (versioning, diff, allocation of free ports
  per node within the configured range), `JobService`, `BackupService`,
  `MigrationService`, `MetricsService` (batch ingestion, purge every hour, aggregation
  at query time), `ImportService`, `RouterService`, `TemplateService`.
- **REST API** `/api/*` for CRUD and actions; **WS** `/ws` for the browser with
  subscriptions (`server:<id>:logs`, `server:<id>:observed`, `node:<id>:metrics`, `jobs`).
- **Migration** (`MigrationService`): job with visible steps: (1) stop on the source if
  the user asks or if it is running, (2) `pre_migration` backup, (3) `BackupPush`
  source→panel and `BackupPull` panel→target in parallel (streaming, without touching the
  panel's disk apart from a buffer), (4) create the spec on the target with a free port, (5) `BackupRestore`,
  (6) start and wait for `health=healthy` or 5 min, (7) `removed_ids` on the source and deletion
  of the source's data directory **only** if the user checked “delete source”; by
  default it is kept renamed `data.migrated-<ts>`.
  With the router (Plan 8): the target router's port is not proposed; the hostname must be
  free on the target (when planning and again, without `await`, right before the commit, same
  as the router port); a server with a hostname is **not migrated** (409) if the source's router
  has autoscale, because mc-router would start it on the source between the stop and the
  retirement (the agent also rejects that `pre_migration` backup); and after migrating, the hostname's DNS
  must point to the target (the Migrate tab warns about it).
- **Router** (`RouterService`, Plan 8): the `router_deployments` row is the truth. Each
  change is sent immediately (`RouterApply` if active, `RouterRemove` if not), chained per
  node, and resent after each handshake; a `RouterObserved` with a router the panel doesn't want
  triggers a `RouterRemove`. There is no `deploy_router` job. Enabling on an agent without support
  (`unsupported`) is not saved (409). The router's port is not handed out and can't be published
  on the node, and it is not enabled on one occupied by a server or reserved by a migration towards
  the node, nor with autoscale while a migration of a server with a hostname is leaving it. A
  node with the router active (or being retired, connected) is not deleted.
  - In the agent, a `mcsm-router` container of `itzg/mc-router` **pinned by digest**
    (`1.47.1@sha256:…`) with `-in-docker`, on the servers' network. Since Plan 9 it doesn't receive
    the Docker socket: it mounts, read-only, the directory of the agent's filtered socket
    (`<DATA_ROOT>/.mcsm-router/docker.sock`, `-docker-socket`), an allowlist proxy that only
    permits ping, version, info, listing and inspecting (without `Config.Env`) the containers with
    `mc-router.host`, following their events and starting or stopping this agent's servers with a hostname
    that are not reserved (nor, to start, held by a crash loop); nothing with a body or
    with API < 1.24. Mounting the directory (not the file) lets mc-router reconnect on its own to the
    new socket on every agent start; if the proxy can't listen, the agent retries
    (1–30 s) and the error shows in the router's state. Hardened: user 65532 (owner of the socket,
    0600), `CapDrop ALL`, `no-new-privileges`, read-only root, 256 MiB and 256 processes,
    `-connection-rate-limit 10`, `json-file` logs with rotation. Own hash in
    `mcsm.router_hash` (independent of `mcsm.spec_hash`): a change recreates it (it has no
    state). It is reconciled at startup, every 30 s and on its events; a failed start or one
    running without publishing its port (Docker 29.7.2) is deleted and recreated.
  - On-demand (autoscale): the reconciler creates and recreates the container but doesn't enforce
    the desired state (mc-router does; `Power` does take charge), except that a container that never
    started is started, because mc-router wouldn't see it; it puts it to sleep after the minutes without
    players. The reservation (`Hold`) only holds back the agent: while a restore, a cold backup
    or a lock without `data` reserve an on-demand server, the agent **parks** it
    (`Park`: stops it and deletes the container; the data is in the bind) and recreates it when the
    reservation is released.

## 8. Web interface

Pages:
- **Home**: node cards (online, CPU/RAM/disk) and a servers table
  (state, players, version, node, port, quick actions).
- **Server**: tabs *Overview* (state, players, 1h/24h/7d charts, actions),
  *Console* (live logs + command input, filter), *Configuration* (sectioned form that
  edits the spec: General, Version and mods, Properties, Players, Network,
  Resources, Backups, Advanced/free env; the “Review and apply” button shows the diff and recreates),
  *Files*, *Backups*, *History* (jobs and events).
- **New server**: 3-step wizard (template or from scratch → node and name → review).
- **Templates**: list, create, edit, duplicate, “create server from template”.
- **Nodes**: list, enrollment (shows `docker run` with token), detail with metrics,
  servers, mc-router (enable, port, autoscale with its minutes and the list of players who
  wake servers; live state), import of containers. Each server's hostname
  goes in Configuration → Network.
- **Jobs**: global list with progress and log.
- **Settings**: password, panel URL, CurseForge API key, default port range.

Style: shadcn/ui, dark mode by default, dense but readable; it is an administration
tool, not a landing page.

## 9. Security (LAN scope, one user)

- Password login (`scrypt` hash from `node:crypto`, no native dependencies), `HttpOnly` cookie, `SameSite=Strict`. Login rate limit.
- Node tokens: 32 random bytes, SHA-256 hash in the DB (high entropy, doesn't need a slow KDF), constant-time comparison.
  Rotation from the UI (the panel sends `RotateToken`, the agent stores the new one and reconnects).
- Enrollment tokens: single use, 15 min.
- The agent validates that the `server_id` of any file/backup operation belongs
  to its node. Confined paths (6.6). Slug names restricted to `[a-z0-9-]{1,40}`.
- `rconPassword` is not shown in the UI by default (reveal button) and doesn't travel to the browser in listings.
- The Docker socket gives effective root on the node (the agent has it); this is clearly documented in the README.
  mc-router doesn't receive it: it uses the agent's filtered socket (§7).

## 10. Error handling

- **Node offline**: the UI marks it; spec changes are stored with a new version
  and delivered in `SyncSpecs` on reconnect. Immediate actions (power,
  console, files) fail with a clear message instead of being queued.
- **Failure applying a spec**: `observed.error` visible on the server's card with Docker's
  text (port in use, invalid image, memory). The agent retries with backoff.
- **MC server crash**: a `die` event with exit code ≠ 0 that nobody requested → `Event` `crash` and, if
  `restartPolicy` allows, Docker restarts it. Each requested stop (the agent's Stop/Kill/Remove or a
  stop the proxy lets mc-router do) explains a single `die` of that container in the following 3 min;
  those of a reserved server, those of containers without the agent's spec and those of
  an adopted import that hasn't yet been recreated with the `mcsm.*` labels don't count.
  With more than 3 in an hour the agent stops it and **holds** it (stored in its store): neither the
  reconciler, nor Docker, nor mc-router starts it until a manual **Start** or a new spec
  version; it emits `Event` `crash_loop` and the panel sets its desired state to stopped. An OOM
  emits `Event` `oom`.
- **Failed backup**: `save-on` guaranteed in `defer`; job marked `failed` with the cause;
  the partial file is deleted.
- **Failed migration**: any failed step leaves the source intact and running as
  it was; whatever was created on the target is cleaned up; the job explains it step by step.
- **Panel restarted mid-job**: `running` jobs become `failed` with
  “interrupted” on startup, except backups, which the agent reports on reconnecting.

## 11. Tests

- **Agent (Go)**: unit tests for `spec → ContainerConfig` (tables), path
  confinement, RCON client (against a fake RCON server), SLP ping (against a
  recorded response), reconciler (with a `docker.Fake` that simulates states), backup
  scheduler and pruning (with an injectable clock). Integration (`go test -tags integration`)
  against real Docker: create a small `VANILLA` itzg server, wait for healthy,
  RCON command, backup, restore, delete.
- **Panel (TS)**: Vitest for services (port allocation, versioning, spec
  diff, migration with simulated agents over the same protocol), HTTP routes with
  `fastify.inject`, and a *fake agent in TS* that implements the protocol to test
  reconnection and `SyncSpecs`.
- **Web**: Playwright on a test `docker-compose` with panel + real agent + an
  itzg server: login, create server, view logs, send command, backup, restore.
- **Protocol**: `buf lint` and `buf breaking` in CI.

## 12. Deployment

`deploy/docker-compose.yml`:

```yaml
services:
  panel:
    image: mcsm-panel:latest   # built from panel/ with `docker compose build`
    ports: ["8080:8080"]
    volumes: ["panel-data:/data"]
    environment: { PANEL_PUBLIC_URL: "http://192.168.1.10:8080" }
  agent:
    image: mcsm-agent:latest   # built from agent/
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/minecraft:/srv/minecraft
      - agent-data:/var/lib/mcsm-agent
      - /proc:/host/proc:ro
    environment:
      PANEL_URL: http://panel:8080
      ENROLL_TOKEN: "<paste from the UI>"
      DATA_ROOT: /srv/minecraft
      HOST_PROC: /host/proc
```

On additional nodes only the `agent` service, with `PANEL_URL` pointing to the panel's IP.
The UI generates the exact block with the token when a node is enrolled.

## 13. Proposed build order

1. Protocol (`proto/`) + agent and panel skeleton + node enrollment + `Hello`.
2. Spec → container, reconciler, power actions, observed state. First UI: nodes and servers.
3. Logs and RCON console.
4. Live and historical metrics.
5. Complete spec configuration form (all sections) and templates.
6. Backups (manual, scheduled, restore, download).
7. Files.
8. Import of existing containers.
9. Migration between nodes.
10. mc-router.
11. Deployment compose, images, README.

Each step leaves the system usable and tested before the next.

## 14. Verified implementation notes (2026-10-12)

- Docker client in Go: modules `github.com/moby/moby/client` v0.6.x and `github.com/moby/moby/api` v1.56.x
  (the old `github.com/docker/docker` has been obsolete since Docker 29). Calls take option
  structs: `ContainerCreate(ctx, ContainerCreateOptions{...})`, `ContainerList(ctx, ContainerListOptions{All: true, Filters: ...})`.
- Server containers are created with `Tty: true` and `OpenStdin: true` (as in the official itzg
  examples). That way `ContainerLogs` returns plain text without multiplexing headers.
- Server containers connect to a user Docker network called `mcsm` that the agent
  also belongs to; the agent reaches RCON and the status ping by DNS name
  `mcsm-<slug>` on internal port 25565/25575. The internal game port is always 25565;
  `ports.game` is the host's port.
- The spec's `properties` are passed to the image with `CUSTOM_SERVER_PROPERTIES` (pairs
  `key=value` separated by a newline), which accepts any `server.properties` key.
- Status ping: `github.com/mcstatus-io/mcutil/v4` (`status.Modern` with `ReceiveLimitBytes` and `Ping: true`).
  RCON: own Source RCON client in `agent/internal/mc` (amendment 2026-10-12: `mcutil/rcon` v4.3.1
  has a data race between `Login` and `Close`, writes to stdout and ignores `context`).
- WebSocket in Go: `github.com/coder/websocket`. Agent store: `go.etcd.io/bbolt`.
- Protobuf: `buf` 1.73 with remote plugins `buf.build/protocolbuffers/go` and `buf.build/bufbuild/es` (v2, `@bufbuild/protobuf` 2.16).
- Toolchain pinned in `mise.toml`: Go 1.27.2, buf 1.73.0; Node 26 and pnpm 12 already installed globally.
