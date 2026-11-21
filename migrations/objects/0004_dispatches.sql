-- 0004 — Feed dispatches on the unified object model.
-- Additive only. Dispatch payloads live in obj_objects.data_json and bodies in
-- obj_revisions; this index supports the public newest-published feed query.

CREATE INDEX IF NOT EXISTS idx_obj_dispatches_published
  ON obj_objects(
    workspace_id,
    kind,
    status,
    json_extract(data_json, '$.published_at') DESC
  )
  WHERE deleted_at IS NULL;

INSERT OR REPLACE INTO obj_meta (k, v) VALUES ('schema_version', '0004');
