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
  {
    // CF_API_KEY pasa a ser reservada: la key que alguien hubiera puesto en el env libre de un
    // servidor se mueve a Ajustes (si no había ya una) y se quita de la spec (versión +1).
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
  // ── plan-4 ──
  // ── plan-5 ──
  // ── plan-6 ──
  // ── plan-7 ──
  // ── plan-8 ──
  // ── plan-9 ──
];
