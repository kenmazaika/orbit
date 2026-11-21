-- 0007: masthead assets + publication records.
-- Additive: existing assets default to role 'auto', state 'inline'.

ALTER TABLE obj_assets ADD COLUMN provider TEXT;
ALTER TABLE obj_assets ADD COLUMN reference_asset_id TEXT;
ALTER TABLE obj_assets ADD COLUMN asset_state TEXT NOT NULL DEFAULT 'inline'; -- inline|candidate|active|historical
ALTER TABLE obj_assets ADD COLUMN revision_id TEXT;
ALTER TABLE obj_assets ADD COLUMN meta_json TEXT;

CREATE INDEX IF NOT EXISTS idx_obj_assets_state ON obj_assets(object_id, asset_state);

-- At most one active masthead per artifact. Enforced in the database, not only in code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_obj_assets_one_masthead
  ON obj_assets(object_id) WHERE asset_state = 'active';

UPDATE obj_meta SET v = '0007' WHERE k = 'schema_version';
