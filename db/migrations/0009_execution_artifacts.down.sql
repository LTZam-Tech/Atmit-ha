-- Rollback of 0009 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP TABLE IF EXISTS execution_artifact;
COMMIT;
