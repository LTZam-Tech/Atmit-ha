-- Rollback of 0006 (development only).
BEGIN;
SET search_path = atimtha, public;
ALTER TABLE execution DROP COLUMN IF EXISTS schedule_id;
DROP TABLE IF EXISTS run_schedule;
COMMIT;
