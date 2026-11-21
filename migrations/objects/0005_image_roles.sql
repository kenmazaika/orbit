-- Image roles and placement. Additive: existing assets default to Auto.
-- requested role  = what Ken asked for (auto | inline | masthead | reference)
-- resolved role   = what the agent decided (inline | masthead | reference | unused)
-- placement_json  = {revisionId, blockIndex, alt} for inline use
ALTER TABLE obj_assets ADD COLUMN role TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE obj_assets ADD COLUMN resolved_role TEXT;
ALTER TABLE obj_assets ADD COLUMN placement_json TEXT;

CREATE INDEX IF NOT EXISTS idx_obj_assets_role ON obj_assets(object_id, role);

UPDATE obj_meta SET v = '0005' WHERE k = 'schema_version';
