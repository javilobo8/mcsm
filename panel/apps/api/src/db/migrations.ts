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
  // ── plan-3 ──
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
  // ── plan-7 ──
  // ── plan-8 ──
  // ── plan-9 ──
];
