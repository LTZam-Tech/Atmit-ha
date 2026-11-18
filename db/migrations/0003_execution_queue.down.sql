-- Rollback of 0003 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP FUNCTION IF EXISTS stale_jobs(interval);
DROP FUNCTION IF EXISTS agent_by_token(text);
DROP INDEX IF EXISTS execution_agent_busy;
DROP INDEX IF EXISTS execution_queue;
ALTER TABLE execution DROP COLUMN IF EXISTS error, DROP COLUMN IF EXISTS requeue_count,
  DROP COLUMN IF EXISTS cancel_requested, DROP COLUMN IF EXISTS job;
ALTER TABLE execution_agent DROP COLUMN IF EXISTS token_hash;
COMMIT;
