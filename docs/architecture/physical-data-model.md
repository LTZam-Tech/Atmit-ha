# Atimtha — physical data model (PostgreSQL)

- Status: DRAFT (ADR-0012 Proposed; backend stack ADR-0006 Proposed)
- Source: [`db/migrations/0001_initial_schema.up.sql`](../../db/migrations/0001_initial_schema.up.sql) · rollback: `0001_initial_schema.down.sql`
- Logical model: the 19-entity ERD (`docs/product/ERD.docx`)

## 1. From the 0.1.0 files to tables

| 0.1.0 entity (ERD) | 0.1.0 storage | Table(s) | Business key kept |
| --- | --- | --- | --- |
| E1 Project | `apps/<app>/app.yml` | `project` (+ run settings, healing policy) | `(workspace_id, key)` = folder name |
| E2 Environment | `app.yml → environments` | `environment` | `(project_id, key)` |
| E3 Login config | `app.yml → login` | `login_config` | one per project |
| E4 User | `app.yml → users` + `secrets.yml` | `test_user` (password → `password_secret_ref`) | `(project_id, key)` |
| E5 Page | `or/<page>.page.yml` | `page` | `(project_id, key)` |
| E6 Element | `elements:` in the page file | `element` (primary strategy as JSONB) | `(page_id, key)` |
| E7 Locator fallback | `fallback:` list | `locator_fallback` | `(element_id, position)` |
| E8 Page visual | `or/.visual/*.png/json` | `page_visual` (image in object storage) | one per page |
| E9 Navigation edge | `navigation.yml` | `navigation_edge` | `(project_id, from, to)` |
| E10 Test case | `cases/<id>.case.yml` | `test_case`, `case_dependency` | `(project_id, key)` = file name |
| E11 Step | `steps:` and `outcomes:` | `test_step` (`outcome = ''` for main steps) | `(case_id, outcome, position)` |
| E12 Data row | `data:` | `data_row` (fields as JSONB) | `(case_id, key)` = TC-001 |
| E13–E14 Workflow, step | `flows/<id>.flow.yml` | `workflow`, `workflow_step` | `(project_id, key)`, `(workflow_id, position)` |
| E15 Run suite | `suites.yml` | `run_suite`, `run_suite_case` | `(project_id, key)` |
| E16 Expected message | `messages.yml` | `expected_message` | `(project_id, locale, key)` |
| E17 Branding profile | `branding/profiles.yml` | `branding_profile` (logo in object storage) | `(organization_id, key)` |
| E18 Run | `reports/history/<app>/<id>/summary.json` | `execution` | UUID; the 0.1.0 timestamp id goes into import metadata |
| E19 Test result | `summary.json → tests[]` | `test_result`, `healing_event`, `evidence` | UUID |

## 2. New platform tables

| Area | Tables | Backlog |
| --- | --- | --- |
| Tenancy and identity | `organization`, `workspace`, `user_account`, `role`, `permission`, `role_permission`, `membership` | §4 |
| Versions and review | `asset_version` (immutable), `change_set` | §4, §15 |
| Audit | `audit_log` (append-only) | §4, §13 |
| Execution | `execution_agent`, `execution` (engine: web, api, mobile, performance) | §10 |
| Evidence | `evidence` (object key, size, SHA-256, expiry) | §11 |
| Healing analytics | `healing_event` (kind, purpose, original failure, substitute) | §6, §11 |
| Configuration | `integration` (no secrets), `feature_flag` | §4, §14 |

## 3. Rules the schema enforces

- **Tenant isolation**: `organization_id` on every tenant row, composite `(id, organization_id)` foreign keys, and
  row-level security on 29 tables keyed by `app.organization_id`.
- **No secrets**: only `*_secret_ref` columns; `audit_log.details` must be masked by the application.
- **Append-only**: `asset_version` and `audit_log` refuse UPDATE and DELETE.
- **Review**: a change set cannot be approved by its author.
- **Model rules carried over from 0.1.0**: key patterns (project, page, element, branding), one default environment,
  no dependency on itself, workflow step 1 cannot `continue`, a page or case cannot be both "logged out" and "as user".

## 4. Migration from 0.1.0

1. Create organisation and workspace, then one `project` per `apps/<key>/`.
2. Insert environments, users (passwords go to the secrets manager first, the row keeps the reference), messages.
3. Insert pages and elements in two passes (elements, then `within`, `ready_when` and login references).
4. Insert cases, steps, rows, dependencies, workflows, suites, navigation.
5. Write version 1 of every asset (`asset_version`) with the original YAML as JSON, so a project exports back byte-for-byte
   equivalent.
6. Optionally import run history (`summary.json`) into `execution` / `test_result`.

The bundled projects under `apps/` (`demo`, `portal`, `txdemo`, `widget`) are the migration fixtures (ADR-0003).

## 5. Open points

- Retention periods for executions and evidence per organisation (backlog §11), and archival target.
- Whether `user_account` passwords are stored at all, or only SSO/OIDC is offered (backlog §13).
- Partitioning of `test_result` and `audit_log` by month once volumes are known.
