-- CI access tokens (backlog §14 "CI"): a pipeline starts runs and reads their results with a token, never a person's
-- account. Only the token's SHA-256 is stored; the token is shown once.
BEGIN;
SET search_path = atimtha, public;

CREATE TABLE ci_token (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  project_id       uuid,                                   -- NULL = every project of the organisation
  name             text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  token_hint       text NOT NULL,                          -- first characters, to recognise a token in the list
  scopes           text[] NOT NULL DEFAULT '{runs.start,runs.read}',
  created_by       uuid REFERENCES user_account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id, name)
);

ALTER TABLE ci_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ci_token
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE execution ADD COLUMN ci_token_id uuid REFERENCES ci_token(id) ON DELETE SET NULL;

-- the API must find the token before it knows the organisation (RLS): owner-run lookup of exactly this hash
CREATE FUNCTION ci_token_by_hash(p_token_hash text)
RETURNS TABLE (token_id uuid, organization_id uuid, project_id uuid, scopes text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = atimtha, pg_temp
AS $$
  SELECT t.id, t.organization_id, t.project_id, t.scopes
  FROM ci_token t
  WHERE t.token_hash = p_token_hash AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
$$;
REVOKE ALL ON FUNCTION ci_token_by_hash(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ci_token TO atimtha_app;
    GRANT EXECUTE ON FUNCTION ci_token_by_hash(text) TO atimtha_app;
  END IF;
END $$;

COMMIT;
