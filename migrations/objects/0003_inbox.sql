-- 0003 — Inbox on the unified object model.
-- Additive only. Inbox payloads live in obj_objects.data_json; decisions use
-- obj_agent_actions, so no feature-specific tables are needed.

CREATE INDEX IF NOT EXISTS idx_obj_objects_legacy_source
  ON obj_objects(workspace_id, legacy_table, external_id);

INSERT OR REPLACE INTO obj_meta (k, v) VALUES ('schema_version', '0003');
