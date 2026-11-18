-- Rollback of 0002 (development only).
BEGIN;
SET search_path = atimtha, public;
DROP FUNCTION IF EXISTS user_organizations(uuid);
DELETE FROM role_permission WHERE role_id IN (SELECT id FROM role WHERE organization_id IS NULL AND built_in);
DELETE FROM role WHERE organization_id IS NULL AND built_in;
DELETE FROM permission;
COMMIT;
