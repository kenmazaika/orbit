CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, created_at);

-- Card projection: vault inbox -> Orbit (source of truth remains the vault).
CREATE TABLE IF NOT EXISTS cards (
  orbit_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  folder TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  instruction TEXT,
  created_at TEXT,
  created_precision TEXT NOT NULL DEFAULT 'datetime',
  updated_at TEXT,
  submitted_at TEXT,
  processed_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  disposition TEXT,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  outbox INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_scope ON cards(outbox, excluded, deleted, created_at);

-- Decisions submitted from Orbit; applied to the original note by the local bridge.
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  orbit_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  base_hash TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  created_at TEXT NOT NULL,
  applied_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status, created_at);
