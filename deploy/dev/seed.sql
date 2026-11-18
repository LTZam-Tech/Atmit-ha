-- DEVELOPMENT DATA ONLY (Docker Compose). Never run against a client installation.
-- One organisation, one workspace, one administrator who signs in with the development login:
--   curl -H "X-Dev-User: admin@atimtha.local" -H "X-Atimtha-Organization: iltizamtech" http://localhost:8080/api/v1/workspaces
BEGIN;
SET search_path = atimtha, public;

INSERT INTO organization (key, name) VALUES ('iltizamtech', 'IltizamTech') ON CONFLICT (key) DO NOTHING;

INSERT INTO workspace (organization_id, key, name)
SELECT id, 'qa', 'QA team' FROM organization WHERE key = 'iltizamtech'
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO user_account (email, display_name, auth_provider, external_subject, status)
VALUES ('admin@atimtha.local', 'Atimtha Admin', 'dev', 'admin@atimtha.local', 'active'),
       ('tester@atimtha.local', 'Atimtha Tester', 'dev', 'tester@atimtha.local', 'active')
ON CONFLICT (email) DO NOTHING;

INSERT INTO membership (organization_id, workspace_id, user_id, role_id)
SELECT o.id, NULL, u.id, r.id
FROM organization o, user_account u, role r
WHERE o.key = 'iltizamtech' AND u.email = 'admin@atimtha.local' AND r.key = 'org-admin' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

-- the tester only sees the "qa" workspace
INSERT INTO membership (organization_id, workspace_id, user_id, role_id)
SELECT o.id, w.id, u.id, r.id
FROM organization o
JOIN workspace w ON w.organization_id = o.id AND w.key = 'qa'
CROSS JOIN user_account u
CROSS JOIN role r
WHERE o.key = 'iltizamtech' AND u.email = 'tester@atimtha.local' AND r.key = 'tester' AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
