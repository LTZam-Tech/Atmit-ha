-- Permissions, built-in roles, the application role's grants, and the one cross-organisation lookup (/api/v1/me).
-- Permission keys match platform/src/Atimtha.Api/Identity/Permissions.cs.
--
-- Database roles (created by deploy/postgres/init-roles.sh, not by migrations):
--   atimtha_owner  owns the schema, runs migrations, BYPASSRLS (also the owner of the SECURITY DEFINER function below)
--   atimtha_app    the API's login: DML only, subject to row-level security, cannot change audit or versions

BEGIN;
SET search_path = atimtha, public;

INSERT INTO permission (key, description) VALUES
  ('org.admin',          'Everything in the organisation'),
  ('workspace.manage',   'Create, rename and archive workspaces'),
  ('member.manage',      'Invite people and change their roles'),
  ('project.view',       'See projects, pages, cases, runs and reports'),
  ('project.edit',       'Change projects, environments, pages, cases and workflows'),
  ('project.delete',     'Archive projects'),
  ('execution.run',      'Start and cancel test runs'),
  ('evidence.view',      'Open screenshots, videos and traces'),
  ('integration.manage', 'Configure Git, CI and test-management integrations'),
  ('audit.view',         'Read the audit log')
ON CONFLICT (key) DO NOTHING;

-- built-in roles (organization_id NULL = offered to every organisation)
INSERT INTO role (organization_id, key, name, built_in) VALUES
  (NULL, 'org-admin', 'Organisation administrator', true),
  (NULL, 'qa-lead',   'QA lead',                    true),
  (NULL, 'tester',    'Tester',                     true),
  (NULL, 'viewer',    'Viewer',                     true)
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO role_permission (role_id, permission_key)
SELECT r.id, p.key
FROM role r
JOIN (VALUES
  ('org-admin', 'org.admin'),
  ('qa-lead', 'workspace.manage'), ('qa-lead', 'member.manage'), ('qa-lead', 'project.view'), ('qa-lead', 'project.edit'),
  ('qa-lead', 'project.delete'), ('qa-lead', 'execution.run'), ('qa-lead', 'evidence.view'), ('qa-lead', 'audit.view'),
  ('tester', 'project.view'), ('tester', 'project.edit'), ('tester', 'execution.run'), ('tester', 'evidence.view'),
  ('viewer', 'project.view'), ('viewer', 'evidence.view')
) AS g(role_key, permission_key) ON g.role_key = r.key AND r.organization_id IS NULL
JOIN permission p ON p.key = g.permission_key
ON CONFLICT DO NOTHING;

-- The organisations and roles of one user, across organisations. Row-level security would hide other organisations'
-- memberships from the API, so this runs as the owner (BYPASSRLS) and returns only the given user's own rows.
CREATE FUNCTION user_organizations(p_user uuid)
RETURNS TABLE (org_key text, org_name text, role_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = atimtha, pg_temp
AS $$
  SELECT o.key, o.name, r.key
  FROM membership m
  JOIN organization o ON o.id = m.organization_id
  JOIN role r ON r.id = m.role_id
  WHERE m.user_id = p_user AND o.archived_at IS NULL
$$;
REVOKE ALL ON FUNCTION user_organizations(uuid) FROM PUBLIC;

-- grants for the API's login, when that role exists (it does in every packaged deployment)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT USAGE ON SCHEMA atimtha TO atimtha_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atimtha TO atimtha_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atimtha TO atimtha_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA atimtha GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atimtha_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA atimtha GRANT USAGE, SELECT ON SEQUENCES TO atimtha_app;
    -- append-only, even for the application
    REVOKE UPDATE, DELETE ON audit_log, asset_version FROM atimtha_app;
    -- reference data is managed by migrations only
    REVOKE INSERT, UPDATE, DELETE ON permission FROM atimtha_app;
    GRANT EXECUTE ON FUNCTION user_organizations(uuid) TO atimtha_app;
  END IF;
END $$;

COMMIT;
