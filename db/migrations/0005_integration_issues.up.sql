-- Defects published from failed results to an integration (ADR-0010, Jira first): one issue per result and integration,
-- so publishing a run twice never files the same defect twice.
BEGIN;
SET search_path = atimtha, public;

ALTER TABLE integration ADD CONSTRAINT integration_id_org_key UNIQUE (id, organization_id);
ALTER TABLE integration ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE integration_issue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  integration_id   uuid NOT NULL,
  test_result_id   uuid NOT NULL,
  execution_id     uuid NOT NULL,
  issue_key        text NOT NULL,                -- e.g. QA-123
  issue_url        text NOT NULL,
  created_by       uuid REFERENCES user_account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (integration_id, organization_id) REFERENCES integration(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (test_result_id, organization_id) REFERENCES test_result(id, organization_id) ON DELETE CASCADE,
  UNIQUE (integration_id, test_result_id)
);
CREATE INDEX integration_issue_execution ON integration_issue (execution_id);

ALTER TABLE integration_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_issue
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON integration, integration_issue TO atimtha_app;
    GRANT SELECT ON feature_flag TO atimtha_app;
  END IF;
END $$;

COMMIT;
