export interface Migration { name: string; sql: string }

export const migrations: Migration[] = [
  {
    name: "001_init",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  data_root TEXT NOT NULL DEFAULT '/srv/minecraft',
  status TEXT NOT NULL DEFAULT 'offline',
  agent_version TEXT,
  docker_version TEXT,
  host_info TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name_hint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  spec TEXT NOT NULL,
  spec_version INTEGER NOT NULL DEFAULT 1,
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  observed TEXT,
  observed_spec_version INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, slug)
);
CREATE INDEX servers_node_idx ON servers(node_id);
`,
  },
  {
    name: "002_enrollment_data_root",
    sql: `ALTER TABLE enrollment_tokens ADD COLUMN data_root TEXT NOT NULL DEFAULT '/srv/minecraft';`,
  },
  // ── plan-2 ──
  {
    // One row per server/node and 10 s window. The primary key is the spec's (scope, scope_id, ts)
    // index and makes ingestion idempotent (INSERT OR REPLACE).
    // No UUID `id` (conscious deviation from §4): ~60k rows per server per week.
    name: "010_metric_samples",
    sql: `
CREATE TABLE metric_samples (
  scope TEXT NOT NULL CHECK (scope IN ('server', 'node')),
  scope_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cpu_pct REAL,
  mem_bytes INTEGER,
  mem_limit_bytes INTEGER,
  net_rx_bytes INTEGER,
  net_tx_bytes INTEGER,
  disk_bytes INTEGER,
  disk_total_bytes INTEGER,
  players_online INTEGER,
  players_max INTEGER,
  tps REAL,
  ping_ms INTEGER,
  PRIMARY KEY (scope, scope_id, ts)
) WITHOUT ROWID;
`,
  },
  {
    // The hourly purge (DELETE ... WHERE ts < ?) does not filter by scope: without this index it scans the whole table.
    name: "011_metric_samples_ts",
    sql: `CREATE INDEX metric_samples_ts ON metric_samples (ts);`,
  },
  // ── plan-3 ──
  {
    // CF_API_KEY becomes reserved: a key someone may have put in a server's free env
    // is moved to Settings (if there was not one already) and removed from the spec (version +1).
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
  // ── plan-4 ──
  {
    name: "030_jobs_backups",
    sql: `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','ok','failed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_server_idx ON jobs(server_id, created_at);
CREATE INDEX jobs_status_idx ON jobs(status, node_id);
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  spec_version INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled','pre_migration','pre_restore')),
  status TEXT NOT NULL CHECK (status IN ('running','ok','failed','deleted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(server_id, filename)
);
CREATE INDEX backups_server_idx ON backups(server_id, started_at);
`,
  },
  // ── plan-5 ──
  // ── plan-6 ──
  {
    // Origin of an imported server (spec §4 imported_from): original container, adoption
    // version and Docker Compose project/service. JSON; NULL for those created by the panel.
    name: "050_servers_imported_from",
    sql: `ALTER TABLE servers ADD COLUMN imported_from TEXT;`,
  },
  // ── plan-7 ──
  {
    // Migrations between nodes (spec §7). Open ones (running, rolling_back, committed) protect the
    // server in SyncSpecs and block actions; deleting a node deletes its own (escape hatch if it never comes back).
    name: "060_migrations",
    sql: `
CREATE TABLE migrations (
  id TEXT PRIMARY KEY,
  -- No foreign key to servers on purpose: after the commit the server can be deleted and the removal of the source
  -- (or the cleanup of the target) is still pending and must go through anyway.
  server_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  target_version INTEGER NOT NULL,
  target_port INTEGER NOT NULL,
  target_spec TEXT NOT NULL,
  was_running INTEGER NOT NULL,
  delete_source INTEGER NOT NULL,
  phase TEXT NOT NULL,
  target_touched INTEGER NOT NULL DEFAULT 0,
  target_started INTEGER NOT NULL DEFAULT 0,
  source_pending INTEGER NOT NULL DEFAULT 0,
  target_pending INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX migrations_server_idx ON migrations(server_id, created_at);
CREATE INDEX migrations_phase_idx ON migrations(phase);
`,
  },
  {
    // target_confirm_pending: after the commit MigrateConfirm is still missing on the target (its marker stays “committed”).
    // pending_error: last failure of what is pending (undo, confirm, remove) or why retrying stopped.
    name: "061_migrations_pending",
    sql: `
ALTER TABLE migrations ADD COLUMN target_confirm_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migrations ADD COLUMN pending_error TEXT;
`,
  },
  // ── plan-8 ──
  {
    // mc-router per node (spec §4 router_deployments): spec = RouterDeploymentSpec (shared/router.ts),
    // observed = last RouterObserved from the agent. No row = the panel never configured it.
    name: "070_router_deployments",
    sql: `
CREATE TABLE router_deployments (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  observed TEXT,
  observed_at TEXT,
  updated_at TEXT
);
`,
  },
  // ── plan-9 ──
  {
    // Agent (Event, spec §5.3) and panel events. server_id has no foreign key on purpose: the history
    // outlives the server (server_name keeps its name at the time). Deleting a node deletes its own.
    name: "080_events",
    sql: `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  server_id TEXT,
  server_name TEXT,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  agent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX events_created_idx ON events(created_at);
CREATE INDEX events_server_idx ON events(server_id, created_at);
`,
  },
  {
    // Node token rotation (spec §9): the new hash is valid alongside the current one until the agent connects with it.
    name: "081_nodes_pending_token",
    sql: `
ALTER TABLE nodes ADD COLUMN pending_token_hash TEXT;
ALTER TABLE nodes ADD COLUMN pending_token_at TEXT;
CREATE UNIQUE INDEX nodes_pending_token_idx ON nodes(pending_token_hash) WHERE pending_token_hash IS NOT NULL;
`,
  },
  {
    // When the desired state last changed: a late crash_loop must not undo a later “Start”.
    name: "082_servers_desired_changed_at",
    sql: `ALTER TABLE servers ADD COLUMN desired_changed_at TEXT;`,
  },
];
