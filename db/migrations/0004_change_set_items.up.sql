-- Proposed asset contents of a change set (ADR-0007): reviewed, then applied as new immutable versions.
BEGIN;
SET search_path = atimtha, public;

CREATE TABLE change_set_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  change_set_id   uuid NOT NULL,
  asset_type      asset_type NOT NULL,
  asset_key       text NOT NULL,                 -- case key (file name), page key, workflow key
  asset_id        uuid,                          -- NULL = a new asset
  base_version    integer,                       -- version the edit started from; NULL for a new asset
  content         jsonb NOT NULL,                -- the proposed asset, 0.1.0 shape
  content_sha256  text NOT NULL,
  FOREIGN KEY (change_set_id, organization_id) REFERENCES change_set(id, organization_id) ON DELETE CASCADE,
  UNIQUE (change_set_id, asset_type, asset_key)
);

ALTER TABLE change_set
  ADD COLUMN decision_note text;

ALTER TABLE change_set_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_set_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON change_set_item
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON change_set_item TO atimtha_app;
  END IF;
END $$;

COMMIT;
