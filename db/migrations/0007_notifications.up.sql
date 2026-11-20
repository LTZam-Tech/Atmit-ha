-- Run notifications (backlog §11): channels that hear about finished runs, and an outbox of deliveries so a
-- message is sent once, retried when the receiver is down, and visible to administrators.
BEGIN;
SET search_path = atimtha, public;

CREATE TYPE notification_kind AS ENUM ('webhook', 'slack', 'teams');
CREATE TYPE delivery_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE notification_channel (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  project_id          uuid,                               -- NULL = every project of the organisation
  name                text NOT NULL,
  kind                notification_kind NOT NULL,
  target_secret_ref   text NOT NULL,                      -- the webhook address is a secret: vault:env/… or vault:file/…
  signing_secret_ref  text,                               -- webhook only: HMAC-SHA256 signature of the body
  events              text[] NOT NULL DEFAULT '{run.failed}',  -- run.failed, run.passed, run.finished
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE notification_delivery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  channel_id       uuid NOT NULL,
  execution_id     uuid NOT NULL,
  event            text NOT NULL,
  status           delivery_status NOT NULL DEFAULT 'pending',
  attempts         smallint NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  FOREIGN KEY (channel_id, organization_id) REFERENCES notification_channel(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, organization_id) REFERENCES execution(id, organization_id) ON DELETE CASCADE,
  UNIQUE (channel_id, execution_id, event)
);
CREATE INDEX notification_delivery_pending ON notification_delivery (next_attempt_at) WHERE status = 'pending';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_channel', 'notification_delivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid) ' ||
      'WITH CHECK (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON notification_channel, notification_delivery TO atimtha_app;
  END IF;
END $$;

COMMIT;
