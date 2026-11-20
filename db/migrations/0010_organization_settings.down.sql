-- Rollback of 0010 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP POLICY IF EXISTS read_defaults_and_own ON feature_flag;
DROP POLICY IF EXISTS write_own ON feature_flag;
DROP POLICY IF EXISTS update_own ON feature_flag;
DROP POLICY IF EXISTS delete_own ON feature_flag;
ALTER TABLE feature_flag NO FORCE ROW LEVEL SECURITY;
ALTER TABLE feature_flag DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS organization_setting;
COMMIT;
