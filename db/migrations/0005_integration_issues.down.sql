-- Rollback of 0005 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP TABLE IF EXISTS integration_issue;
ALTER TABLE integration DROP COLUMN IF EXISTS updated_at;
ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_id_org_key;
COMMIT;
