-- Scheduled runs (backlog §10): a cron expression in the schedule's time zone starts a run of a project.
BEGIN;
SET search_path = atimtha, public;

CREATE TABLE run_schedule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  project_id         uuid NOT NULL,
  name               text NOT NULL,
  cron               text NOT NULL,                     -- 5 fields: minute hour day-of-month month day-of-week
  time_zone          text NOT NULL DEFAULT 'Asia/Riyadh',
  environment_id     uuid NOT NULL,
  engine             engine_kind NOT NULL DEFAULT 'web',
  selection          jsonb NOT NULL DEFAULT '{}',
  healing            healing_policy,                     -- NULL = the project's policy
  enabled            boolean NOT NULL DEFAULT true,
  next_run_at        timestamptz,
  last_run_at        timestamptz,
  last_execution_id  uuid,
  created_by         uuid REFERENCES user_account(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, organization_id) REFERENCES environment(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, name)
);
CREATE INDEX run_schedule_due ON run_schedule (next_run_at) WHERE enabled;

ALTER TABLE run_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_schedule
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE execution ADD COLUMN schedule_id uuid REFERENCES run_schedule(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON run_schedule TO atimtha_app;
  END IF;
END $$;

COMMIT;
