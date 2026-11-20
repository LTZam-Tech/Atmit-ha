-- Rollback of 0011 (development only).
BEGIN;
SET search_path = atimtha, public;
ALTER TABLE run_schedule DROP COLUMN IF EXISTS shards;
DROP INDEX IF EXISTS execution_parent;
ALTER TABLE execution DROP CONSTRAINT IF EXISTS execution_shard_check;
ALTER TABLE execution DROP COLUMN IF EXISTS parent_execution_id, DROP COLUMN IF EXISTS shard_index, DROP COLUMN IF EXISTS shard_total;
COMMIT;
