-- Rollback of 0004 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP TABLE IF EXISTS change_set_item;
ALTER TABLE change_set DROP COLUMN IF EXISTS decision_note;
COMMIT;
