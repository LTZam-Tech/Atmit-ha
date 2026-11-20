-- Organisation settings (backlog §4 "central system configuration") and feature-flag overrides an organisation
-- administrator can change. Platform defaults (feature_flag.organization_id NULL) stay read-only for the application.
BEGIN;
SET search_path = atimtha, public;

CREATE TABLE organization_setting (
  organization_id uuid NOT NULL REFERENCES organization(id),
  key             text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9.]*$'),
  value           jsonb NOT NULL,
  updated_by      uuid REFERENCES user_account(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

ALTER TABLE organization_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_setting
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- feature flags: everyone reads the platform defaults and their own overrides; only their own can be written
ALTER TABLE feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flag FORCE ROW LEVEL SECURITY;
CREATE POLICY read_defaults_and_own ON feature_flag FOR SELECT
  USING (organization_id IS NULL OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY write_own ON feature_flag FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY update_own ON feature_flag FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY delete_own ON feature_flag FOR DELETE
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_setting TO atimtha_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flag TO atimtha_app;
  END IF;
END $$;

COMMIT;
