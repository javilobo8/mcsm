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
    // Una fila por servidor/nodo y ventana de 10 s. La clave primaria es el índice
    // (scope, scope_id, ts) de la spec y hace idempotente la ingesta (INSERT OR REPLACE).
    // Sin `id` UUID (desviación consciente de §4): ~60k filas por servidor y semana.
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
  // ── plan-3 ──
  // ── plan-4 ──
  // ── plan-5 ──
  // ── plan-6 ──
  // ── plan-7 ──
  // ── plan-8 ──
  // ── plan-9 ──
];
