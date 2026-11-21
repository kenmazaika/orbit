-- 0006: claim ownership + retry scheduling for obj_agent_actions.
-- Additive only: existing rows keep NULL claim_token and are claimable as before.
ALTER TABLE obj_agent_actions ADD COLUMN claim_token TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN next_attempt_at TEXT;
ALTER TABLE obj_agent_actions ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;

CREATE INDEX IF NOT EXISTS idx_obj_actions_queue
  ON obj_agent_actions(workspace_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_obj_actions_lease
  ON obj_agent_actions(status, lease_expires_at);
