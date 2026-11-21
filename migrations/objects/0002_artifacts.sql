-- 0002 — Artifacts on the unified object model.
-- Additive only. Extends 0001; safe to apply to a database that already has poc_*.

ALTER TABLE obj_objects ADD COLUMN created_by TEXT;
ALTER TABLE obj_objects ADD COLUMN current_revision_id TEXT;
ALTER TABLE obj_objects ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE obj_objects ADD COLUMN legacy_table TEXT;

ALTER TABLE obj_revisions ADD COLUMN legacy_id TEXT;
ALTER TABLE obj_revisions ADD COLUMN base_revision_id TEXT;
ALTER TABLE obj_revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'published';

ALTER TABLE obj_agent_actions ADD COLUMN legacy_id TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN lease_expires_at TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE obj_agent_actions ADD COLUMN reply TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN workflow TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN request_kind TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_objects_external
  ON obj_objects(workspace_id, kind, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_revisions_legacy
  ON obj_revisions(legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_actions_legacy
  ON obj_agent_actions(legacy_id) WHERE legacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_obj_actions_object
  ON obj_agent_actions(object_id, created_at DESC);

-- Binary assets (artifact images). Kept out of obj_objects so object rows stay small.
CREATE TABLE IF NOT EXISTS obj_assets (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  object_id      TEXT NOT NULL,
  request_id     TEXT,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  data           BLOB NOT NULL,
  include_flag   INTEGER NOT NULL DEFAULT 1,
  instruction    TEXT,
  legacy_id      TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obj_assets_object ON obj_assets(object_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_assets_legacy
  ON obj_assets(legacy_id) WHERE legacy_id IS NOT NULL;

-- Scoped, revocable agent tokens. Only the sha256 hash is stored.
CREATE TABLE IF NOT EXISTS obj_api_tokens (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT 'agent',
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

INSERT OR REPLACE INTO obj_meta (k, v) VALUES ('schema_version', '0002');
