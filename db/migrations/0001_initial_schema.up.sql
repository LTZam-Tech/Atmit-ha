-- Atimtha platform — initial PostgreSQL schema (backlog §5; docs/architecture/physical-data-model.md)
-- Status: DRAFT. Backend stack is still Proposed (ADR-0006); this schema is stack-agnostic.
-- Requires PostgreSQL 15+ (UNIQUE NULLS NOT DISTINCT, ON DELETE SET NULL (column)); extensions: citext.
--
-- Conventions
--   • Every row has a UUID primary key; the 0.1.0 business keys (project key, page key, case file name, TC-001…)
--     stay as unique columns within their parent, so YAML projects import and export without renames.
--   • Every tenant table carries organization_id, and children reference parents by (id, organization_id):
--     a row can never point at another organisation's data, even through a bug in application code.
--   • Row-level security filters every tenant table by the session setting app.organization_id.
--   • Secrets are never stored: *_secret_ref columns hold a reference into the secrets manager.
--   • Versions and audit entries are append-only (triggers refuse UPDATE and DELETE).

BEGIN;

CREATE SCHEMA IF NOT EXISTS atimtha;
SET search_path = atimtha, public;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================== enums
CREATE TYPE page_open_mode   AS ENUM ('url', 'navigate');
CREATE TYPE case_type        AS ENUM ('positive', 'negative');
CREATE TYPE workflow_start   AS ENUM ('continue', 'open');
CREATE TYPE asset_type       AS ENUM ('project', 'page', 'test_case', 'workflow', 'navigation', 'run_suite', 'messages');
CREATE TYPE change_status    AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'merged');
CREATE TYPE change_source    AS ENUM ('central', 'local');
CREATE TYPE agent_kind       AS ENUM ('central', 'local', 'private');
CREATE TYPE agent_status     AS ENUM ('pending', 'active', 'offline', 'revoked');
CREATE TYPE execution_status AS ENUM ('queued', 'assigned', 'running', 'passed', 'failed', 'cancelled', 'error');
CREATE TYPE engine_kind      AS ENUM ('web', 'api', 'mobile', 'performance');
CREATE TYPE result_status    AS ENUM ('passed', 'failed', 'timed_out', 'skipped', 'interrupted');
CREATE TYPE failure_category AS ENUM ('application_defect', 'locator_or', 'self_healing', 'environment', 'timeout', 'script_error', 'infrastructure');
CREATE TYPE heal_kind        AS ENUM ('fallback-locator', 'ready-element', 'navigation-route');
CREATE TYPE heal_purpose     AS ENUM ('check', 'action', 'navigation');
CREATE TYPE healing_policy   AS ENUM ('pass', 'flag', 'off');
CREATE TYPE evidence_kind    AS ENUM ('screenshot', 'video', 'trace', 'log', 'har', 'other');
CREATE TYPE integration_kind AS ENUM ('git', 'jira', 'azure_devops', 'testrail', 'ci');

-- ============================================================== tenancy and identity
CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE workspace (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,
  UNIQUE (organization_id, key),
  UNIQUE (id, organization_id)
);

-- people are global (one person can belong to several organisations); credentials live with the identity provider
CREATE TABLE user_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  display_name     text NOT NULL,
  locale           text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  auth_provider    text NOT NULL DEFAULT 'local',          -- local | oidc | saml
  external_subject text,                                   -- subject id at the identity provider
  password_hash    text,                                   -- only for auth_provider = 'local' (argon2id)
  mfa_enabled      boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  UNIQUE (auth_provider, external_subject)
);

CREATE TABLE permission (
  key         text PRIMARY KEY,                            -- e.g. project.edit, execution.run, evidence.view
  description text NOT NULL
);

-- organization_id NULL = built-in role available to every organisation
CREATE TABLE role (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organization(id),
  key             text NOT NULL,
  name            text NOT NULL,
  built_in        boolean NOT NULL DEFAULT false,
  UNIQUE NULLS NOT DISTINCT (organization_id, key)
);

CREATE TABLE role_permission (
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key),
  PRIMARY KEY (role_id, permission_key)
);

-- workspace_id NULL = organisation-wide membership
CREATE TABLE membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  workspace_id    uuid,
  user_id         uuid NOT NULL REFERENCES user_account(id),
  role_id         uuid NOT NULL REFERENCES role(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, organization_id) REFERENCES workspace(id, organization_id),
  UNIQUE NULLS NOT DISTINCT (user_id, organization_id, workspace_id)
);

-- ============================================================== branding (E17)
CREATE TABLE branding_profile (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  key             text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]*$'),
  name            text NOT NULL,
  company         text,
  client          text,
  primary_color   text CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  report_title    text,
  footer          text,
  confidentiality text,
  logo_object_key text,                                     -- object storage, not inline base64
  UNIQUE (organization_id, key),
  UNIQUE (id, organization_id)
);

-- ============================================================== project (E1–E4, E16)
CREATE TABLE project (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  key                 text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]*$'),  -- the 0.1.0 apps/<key> folder name
  name                text NOT NULL,
  description         text,
  test_id_attribute   text NOT NULL DEFAULT 'data-testid',
  languages           text[] NOT NULL DEFAULT '{en}' CHECK (languages <@ ARRAY['en', 'ar']),
  branding_profile_id uuid,
  run_workers         smallint CHECK (run_workers BETWEEN 1 AND 16),
  run_retries         smallint CHECK (run_retries BETWEEN 0 AND 3),
  run_test_timeout_s  smallint CHECK (run_test_timeout_s BETWEEN 5 AND 900),
  run_wait_timeout_s  smallint CHECK (run_wait_timeout_s BETWEEN 1 AND 120),
  healing_policy      healing_policy NOT NULL DEFAULT 'pass',
  created_by          uuid REFERENCES user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  FOREIGN KEY (workspace_id, organization_id) REFERENCES workspace(id, organization_id),
  FOREIGN KEY (branding_profile_id, organization_id) REFERENCES branding_profile(id, organization_id),
  UNIQUE (workspace_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE environment (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  project_id                 uuid NOT NULL,
  key                        text NOT NULL,
  base_url                   text NOT NULL,
  is_default                 boolean NOT NULL DEFAULT false,
  start_demo_app             boolean NOT NULL DEFAULT false,
  ignore_https_errors        boolean NOT NULL DEFAULT false,
  http_username              text,
  http_password_secret_ref   text,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);
CREATE UNIQUE INDEX environment_one_default ON environment (project_id) WHERE is_default;

CREATE TABLE test_user (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  project_id          uuid NOT NULL,
  key                 text NOT NULL,                        -- {{user.<key>.username}}
  username            text NOT NULL,
  password_secret_ref text,                                 -- never the password itself
  description         text,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE expected_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  locale          text NOT NULL CHECK (locale IN ('en', 'ar')),
  key             text NOT NULL,                            -- {{msg.<key>}}
  text            text NOT NULL,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, locale, key)
);

-- ============================================================== Smart Object Repository (E5–E8)
CREATE TABLE page (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  project_id             uuid NOT NULL,
  key                    text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9]*$'),
  url                    text,
  open_mode              page_open_mode NOT NULL DEFAULT 'url',
  description            text,
  ready_when_element_id  uuid,                              -- FK added below (element is created after page)
  auth_user_id           uuid,                              -- NULL with auth_logged_out = false: no session
  auth_logged_out        boolean NOT NULL DEFAULT false,    -- the 0.1.0 auth: none
  tags                   text[] NOT NULL DEFAULT '{}',
  settings               jsonb NOT NULL DEFAULT '{}',       -- timeout, defaultStrategy, fallback
  current_version        integer NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (auth_user_id, organization_id) REFERENCES test_user(id, organization_id),
  CHECK (NOT (auth_logged_out AND auth_user_id IS NOT NULL)),
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE element (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  page_id           uuid NOT NULL,
  key               text NOT NULL CHECK (key ~ '^[a-zA-Z][a-zA-Z0-9]*$'),
  position          integer NOT NULL DEFAULT 0,
  strategy          jsonb NOT NULL,                         -- primary: {"testid": "..."} | {"role": "...", "name": ...} | …
  within_element_id uuid,
  frame             text,
  nth               integer,
  has_text          jsonb,                                  -- LocalizedText
  control           text,
  semantic          text,
  rules             jsonb,                                  -- required, minlength, maxlength, min, max, pattern, readonly
  format            text,
  options           text[],
  href              text,
  new_tab           boolean,
  messages          text[],
  description       text,
  FOREIGN KEY (page_id, organization_id) REFERENCES page(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (within_element_id, organization_id) REFERENCES element(id, organization_id),
  CHECK (jsonb_typeof(strategy) = 'object'),
  UNIQUE (page_id, key),
  UNIQUE (id, organization_id)
);

ALTER TABLE page ADD FOREIGN KEY (ready_when_element_id, organization_id)
  REFERENCES element(id, organization_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE locator_fallback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  element_id      uuid NOT NULL,
  position        integer NOT NULL CHECK (position >= 1),
  strategy        jsonb NOT NULL,
  FOREIGN KEY (element_id, organization_id) REFERENCES element(id, organization_id) ON DELETE CASCADE,
  UNIQUE (element_id, position)
);

CREATE TABLE page_visual (
  page_id               uuid PRIMARY KEY,
  organization_id       uuid NOT NULL,
  screenshot_object_key text NOT NULL,
  url                   text,
  width                 integer,
  height                integer,
  boxes                 jsonb NOT NULL DEFAULT '{}',        -- element key → {x, y, w, h}
  captured_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (page_id, organization_id) REFERENCES page(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE navigation_edge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  from_page_id    uuid NOT NULL,
  to_page_id      uuid NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]',              -- serialized steps, same shape as test_step.body
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (from_page_id, organization_id) REFERENCES page(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (to_page_id, organization_id) REFERENCES page(id, organization_id) ON DELETE CASCADE,
  CHECK (from_page_id <> to_page_id),
  UNIQUE (project_id, from_page_id, to_page_id)
);

CREATE TABLE login_config (
  project_id           uuid PRIMARY KEY,
  organization_id      uuid NOT NULL,
  page_id              uuid NOT NULL,
  username_element_id  uuid NOT NULL,
  password_element_id  uuid NOT NULL,
  submit_element_id    uuid NOT NULL,
  success_element_id   uuid,
  success_url_contains text,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (page_id, organization_id) REFERENCES page(id, organization_id),
  FOREIGN KEY (username_element_id, organization_id) REFERENCES element(id, organization_id),
  FOREIGN KEY (password_element_id, organization_id) REFERENCES element(id, organization_id),
  FOREIGN KEY (submit_element_id, organization_id) REFERENCES element(id, organization_id),
  FOREIGN KEY (success_element_id, organization_id) REFERENCES element(id, organization_id)
);

-- ============================================================== test assets (E10–E15)
CREATE TABLE test_case (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  project_id            uuid NOT NULL,
  key                   text NOT NULL,                      -- the 0.1.0 file name without .case.yml
  engine                engine_kind NOT NULL DEFAULT 'web',
  title                 text NOT NULL,
  description           text,
  module                text,
  case_type             case_type,
  start_page_id         uuid,
  start_url             text,
  start_user_id         uuid,
  start_logged_out      boolean NOT NULL DEFAULT false,
  tags                  text[] NOT NULL DEFAULT '{}',
  continue_from_case_id uuid,
  continue_from_row_key text,
  current_version       integer NOT NULL DEFAULT 1,
  created_by            uuid REFERENCES user_account(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (start_page_id, organization_id) REFERENCES page(id, organization_id),
  FOREIGN KEY (start_user_id, organization_id) REFERENCES test_user(id, organization_id),
  FOREIGN KEY (continue_from_case_id, organization_id) REFERENCES test_case(id, organization_id),
  CHECK (NOT (start_logged_out AND start_user_id IS NOT NULL)),
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE case_dependency (
  organization_id     uuid NOT NULL,
  case_id             uuid NOT NULL,
  depends_on_case_id  uuid NOT NULL,
  PRIMARY KEY (case_id, depends_on_case_id),
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE CASCADE,
  CHECK (case_id <> depends_on_case_id)                    -- longer cycles are refused by the application
);

-- outcome = '' for the case's main steps, else the outcome name (success, error, …)
CREATE TABLE test_step (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  case_id         uuid NOT NULL,
  outcome         text NOT NULL DEFAULT '',
  position        integer NOT NULL,
  action          text NOT NULL,                            -- one of the 24 step actions (src/core/cases/model.ts)
  element_id      uuid,
  element_params  jsonb,                                    -- {sku: "{{data.sku}}"}
  body            jsonb NOT NULL,                           -- the serialized step, as in the YAML
  name            text,
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (element_id, organization_id) REFERENCES element(id, organization_id),
  UNIQUE (case_id, outcome, position)
);

CREATE TABLE data_row (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  case_id         uuid NOT NULL,
  key             text NOT NULL,                            -- TC-001
  position        integer NOT NULL,
  title           text,
  row_type        case_type,
  outcome         text,
  tags            text[] NOT NULL DEFAULT '{}',
  skip            boolean NOT NULL DEFAULT false,
  fields          jsonb NOT NULL DEFAULT '{}',              -- {{data.<field>}} values
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE CASCADE,
  UNIQUE (case_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE workflow (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  key             text NOT NULL,
  title           text NOT NULL,
  description     text,
  module          text,
  tags            text[] NOT NULL DEFAULT '{}',
  current_version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE workflow_step (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  workflow_id     uuid NOT NULL,
  position        integer NOT NULL,
  case_id         uuid NOT NULL,
  data_row_id     uuid,
  run_as_user_id  uuid,
  start_mode      workflow_start,                           -- NULL = default (continue; step 1 opens its start page)
  FOREIGN KEY (workflow_id, organization_id) REFERENCES workflow(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id),
  FOREIGN KEY (data_row_id, organization_id) REFERENCES data_row(id, organization_id),
  FOREIGN KEY (run_as_user_id, organization_id) REFERENCES test_user(id, organization_id),
  CHECK (position >= 1),
  CHECK (NOT (position = 1 AND start_mode = 'continue')),   -- nothing ran before step 1 (flows.ts rule)
  UNIQUE (workflow_id, position)
);

CREATE TABLE run_suite (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  key             text NOT NULL,
  description     text,
  modules         text[] NOT NULL DEFAULT '{}',
  tags            text[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  UNIQUE (project_id, key),
  UNIQUE (id, organization_id)
);

CREATE TABLE run_suite_case (
  organization_id uuid NOT NULL,
  suite_id        uuid NOT NULL,
  case_id         uuid NOT NULL,
  PRIMARY KEY (suite_id, case_id),
  FOREIGN KEY (suite_id, organization_id) REFERENCES run_suite(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE CASCADE
);

-- ============================================================== versions, change sets, audit (backlog §4, §15)
CREATE TABLE change_set (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  title           text NOT NULL,
  status          change_status NOT NULL DEFAULT 'draft',
  source          change_source NOT NULL DEFAULT 'central',
  base_versions   jsonb NOT NULL DEFAULT '{}',              -- asset id → version the change started from (conflict check)
  created_by      uuid NOT NULL REFERENCES user_account(id),
  reviewed_by     uuid REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),  -- no self-approval
  UNIQUE (id, organization_id)
);

-- immutable snapshots: every saved page, case, workflow… gets a new version row
CREATE TABLE asset_version (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  asset_type      asset_type NOT NULL,
  asset_id        uuid NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  content         jsonb NOT NULL,                           -- full snapshot in the 0.1.0 YAML shape
  content_sha256  text NOT NULL,
  change_set_id   uuid,
  created_by      uuid REFERENCES user_account(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (change_set_id, organization_id) REFERENCES change_set(id, organization_id),
  UNIQUE (asset_type, asset_id, version)
);

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organization(id),         -- NULL for platform-level events
  actor_user_id   uuid REFERENCES user_account(id),
  actor_agent_id  uuid,
  action          text NOT NULL,                            -- e.g. case.update, execution.start, member.role_change
  resource_type   text NOT NULL,
  resource_id     text,
  details         jsonb NOT NULL DEFAULT '{}',              -- never secrets (application masks them)
  ip              inet,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_at ON audit_log (organization_id, at DESC);

CREATE FUNCTION refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER asset_version_immutable BEFORE UPDATE OR DELETE ON asset_version FOR EACH ROW EXECUTE FUNCTION refuse_change();
CREATE TRIGGER audit_log_immutable     BEFORE UPDATE OR DELETE ON audit_log     FOR EACH ROW EXECUTE FUNCTION refuse_change();

-- ============================================================== execution, agents, results, evidence (E18–E19, backlog §10–§11)
CREATE TABLE execution_agent (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organization(id),
  name                    text NOT NULL,
  kind                    agent_kind NOT NULL,
  status                  agent_status NOT NULL DEFAULT 'pending',
  capabilities            jsonb NOT NULL DEFAULT '{}',      -- engines, browsers, devices, max concurrency
  certificate_fingerprint text,                             -- mTLS client certificate (SHA-256)
  version                 text,
  last_heartbeat_at       timestamptz,
  registered_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz,
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);
ALTER TABLE audit_log ADD FOREIGN KEY (actor_agent_id) REFERENCES execution_agent(id);

CREATE TABLE execution (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id      uuid NOT NULL,
  environment_id  uuid NOT NULL,
  engine          engine_kind NOT NULL DEFAULT 'web',
  suite_id        uuid,
  selection       jsonb NOT NULL DEFAULT '{}',              -- cases, rows, tags, grep
  locale          text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  target          text NOT NULL DEFAULT 'local',            -- local | grid | browserstack | lambdatest
  healing_policy  healing_policy NOT NULL,
  seed            bigint,
  status          execution_status NOT NULL DEFAULT 'queued',
  agent_id        uuid,
  requested_by    uuid REFERENCES user_account(id),
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  counts          jsonb,                                    -- total, passed, failed, flaky, skipped, healed, healingFailed…
  FOREIGN KEY (project_id, organization_id) REFERENCES project(id, organization_id),
  FOREIGN KEY (environment_id, organization_id) REFERENCES environment(id, organization_id),
  FOREIGN KEY (suite_id, organization_id) REFERENCES run_suite(id, organization_id),
  FOREIGN KEY (agent_id, organization_id) REFERENCES execution_agent(id, organization_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX execution_project_queued ON execution (project_id, queued_at DESC);
CREATE INDEX execution_open ON execution (status) WHERE status IN ('queued', 'assigned', 'running');

CREATE TABLE test_result (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  execution_id    uuid NOT NULL,
  case_id         uuid,
  data_row_id     uuid,
  workflow_id     uuid,
  title           text NOT NULL,
  module          text,
  kind            text,                                     -- positive | negative | other
  status          result_status NOT NULL,
  flaky           boolean NOT NULL DEFAULT false,
  retries         smallint NOT NULL DEFAULT 0,
  category        failure_category,
  error           text,
  duration_ms     integer,
  steps           jsonb,                                    -- step tree for the report
  last_page       jsonb,
  discoveries     jsonb,
  started_at      timestamptz,
  FOREIGN KEY (execution_id, organization_id) REFERENCES execution(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id, organization_id) REFERENCES test_case(id, organization_id) ON DELETE SET NULL (case_id),
  FOREIGN KEY (data_row_id, organization_id) REFERENCES data_row(id, organization_id) ON DELETE SET NULL (data_row_id),
  FOREIGN KEY (workflow_id, organization_id) REFERENCES workflow(id, organization_id) ON DELETE SET NULL (workflow_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX test_result_execution ON test_result (execution_id);
CREATE INDEX test_result_case ON test_result (case_id, started_at DESC);

-- one row per heal, for locator health and self-healing analytics (src/core/healing.ts)
CREATE TABLE healing_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  test_result_id  uuid NOT NULL,
  kind            heal_kind NOT NULL,
  purpose         heal_purpose NOT NULL,
  target          text NOT NULL,
  original        text NOT NULL,
  healed_by       text NOT NULL,
  fix             text,
  FOREIGN KEY (test_result_id, organization_id) REFERENCES test_result(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX healing_event_target ON healing_event (organization_id, target);

CREATE TABLE evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  test_result_id  uuid NOT NULL,
  kind            evidence_kind NOT NULL,
  name            text NOT NULL,
  object_key      text NOT NULL,                            -- encrypted object storage
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  sha256          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,                              -- retention policy
  FOREIGN KEY (test_result_id, organization_id) REFERENCES test_result(id, organization_id) ON DELETE CASCADE
);

-- ============================================================== integrations and configuration (backlog §4, §14)
CREATE TABLE integration (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organization(id),
  kind                  integration_kind NOT NULL,
  name                  text NOT NULL,
  config                jsonb NOT NULL DEFAULT '{}',        -- URLs, project keys, field mappings — no secrets
  credential_secret_ref text,
  enabled               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- organization_id NULL = platform default
CREATE TABLE feature_flag (
  key             text NOT NULL,
  organization_id uuid REFERENCES organization(id),
  enabled         boolean NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (key, organization_id)
);

-- ============================================================== tenant isolation (row-level security)
-- The application sets `SET LOCAL app.organization_id = '<uuid>'` per transaction; rows of other organisations
-- are invisible and cannot be written. Platform jobs (migrations, retention) run as a role with BYPASSRLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace', 'membership', 'branding_profile', 'project', 'environment', 'test_user', 'expected_message',
    'page', 'element', 'locator_fallback', 'page_visual', 'navigation_edge', 'login_config',
    'test_case', 'case_dependency', 'test_step', 'data_row', 'workflow', 'workflow_step', 'run_suite', 'run_suite_case',
    'change_set', 'asset_version', 'execution_agent', 'execution', 'test_result', 'healing_event', 'evidence', 'integration'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- NULLIF: an unset or empty setting means "no organisation" (no rows), never a cast error
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid) ' ||
      'WITH CHECK (organization_id = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
