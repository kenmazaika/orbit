-- Orbit object model — phase 1 foundation.
--
-- Additive only. Every table is obj_* and created IF NOT EXISTS, so this file can
-- be applied to any database that already holds cards/actions/events/poc_* without
-- touching those rows. Nothing in worker/index.js reads these tables in phase 1.
--
-- Design notes: see docs/objects/README.md and the QBall decisions (01.58).

CREATE TABLE IF NOT EXISTS obj_workspaces (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);

-- One row per entity of any kind. `kind` is the discriminator; external_id keeps
-- the legacy identity (orbit_id, artifact id, note slug) so URLs and agent
-- contracts survive a later re-key.
CREATE TABLE IF NOT EXISTS obj_objects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  external_id  TEXT,
  slug         TEXT,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  data_json    TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  UNIQUE (workspace_id, kind, external_id),
  UNIQUE (workspace_id, kind, slug)
);
CREATE INDEX IF NOT EXISTS idx_obj_objects_scope
  ON obj_objects(workspace_id, kind, status, updated_at DESC);

-- Numbered, content-addressed revisions. Numbering mirrors the artifact V1/V2 UI.
CREATE TABLE IF NOT EXISTS obj_revisions (
  id           TEXT PRIMARY KEY,
  object_id    TEXT NOT NULL,
  number       INTEGER NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source       TEXT NOT NULL,       -- seed | feedback | workflow | import | sync
  actor        TEXT,                -- human id, agent id, or system name
  created_at   TEXT NOT NULL,
  UNIQUE (object_id, number)
);
CREATE INDEX IF NOT EXISTS idx_obj_revisions_object
  ON obj_revisions(object_id, number DESC);

-- Typed edges. Directional by from/to; the reverse index makes backlinks cheap.
CREATE TABLE IF NOT EXISTS obj_relationships (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  from_object_id TEXT NOT NULL,
  to_object_id   TEXT NOT NULL,
  relation       TEXT NOT NULL,     -- parent | cite | reference | duplicate | ...
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  UNIQUE (from_object_id, to_object_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_obj_rel_from ON obj_relationships(from_object_id, relation);
CREATE INDEX IF NOT EXISTS idx_obj_rel_to   ON obj_relationships(to_object_id, relation);

-- Append-only log of what happened. Not a queue, not current state.
CREATE TABLE IF NOT EXISTS obj_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object_id    TEXT,
  type         TEXT NOT NULL,       -- created | submitted | revised | applied | closed | ...
  actor        TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obj_events_ws ON obj_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obj_events_object ON obj_events(object_id, created_at DESC);

-- Agent work items. Same shape the artifact bridge already uses (poc_requests),
-- generalized so a new agent does not need a new table.
CREATE TABLE IF NOT EXISTS obj_agent_actions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  object_id       TEXT,
  agent           TEXT NOT NULL,
  action          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued|claimed|working|done|failed|stale
  idempotency_key TEXT,
  input_json      TEXT NOT NULL DEFAULT '{}',
  output_json     TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_obj_actions_status
  ON obj_agent_actions(status, created_at);

CREATE TABLE IF NOT EXISTS obj_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

INSERT OR REPLACE INTO obj_meta (k, v) VALUES ('schema_version', '0001');
