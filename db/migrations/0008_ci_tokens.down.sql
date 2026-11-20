-- Rollback of 0008 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP FUNCTION IF EXISTS ci_token_by_hash(text);
ALTER TABLE execution DROP COLUMN IF EXISTS ci_token_id;
DROP TABLE IF EXISTS ci_token;
COMMIT;
