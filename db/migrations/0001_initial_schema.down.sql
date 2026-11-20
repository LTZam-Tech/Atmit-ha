-- Rollback of 0001_initial_schema: removes the whole platform schema.
-- DESTRUCTIVE: only for a fresh installation that has not stored data yet. Production rollback = restore from backup.
BEGIN;
DROP SCHEMA IF EXISTS atimtha CASCADE;
COMMIT;
