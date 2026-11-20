-- Run-level artifacts (backlog §11): the Smart HTML report and other files of a whole run, next to the per-test
-- evidence. Same storage and retention as evidence; the content is never served inline (reports contain scripts).
BEGIN;
SET search_path = atimtha, public;

CREATE TABLE execution_artifact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  execution_id    uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('report', 'log', 'other')),
  name            text NOT NULL,
  object_key      text NOT NULL,
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  sha256          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  FOREIGN KEY (execution_id, organization_id) REFERENCES execution(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX execution_artifact_execution ON execution_artifact (execution_id);
CREATE INDEX execution_artifact_expiry ON execution_artifact (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE execution_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON execution_artifact
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, DELETE ON execution_artifact TO atimtha_app;
  END IF;
END $$;

COMMIT;
