# ADR-0012: Database keys, tenant isolation and versioning

- Status: **Accepted** (ADR-0006 decided: .NET; migrations run by the platform, ADR-0013)
- Date: 2026-11-18

## Context

Backlog §5: PostgreSQL as the transactional database, stable UUIDs while keeping existing business identifiers, tenant
isolation at the data-access layer, versioning, audit, and migration of 0.1.0 YAML projects with import/export kept.
In 0.1.0 a rename rewrites every file that mentions the name, and nothing stops one project's data from pointing at
another's.

## Decision

Draft migration: `db/migrations/0001_initial_schema.up.sql` (PostgreSQL 15+), described in
`docs/architecture/physical-data-model.md`.

1. **UUID primary keys everywhere; 0.1.0 keys kept** as unique columns within their parent (project key, page key,
   element key, case file name, row id such as TC-001). References use UUIDs, so a rename touches one row.
2. **Tenant isolation in three layers**: every tenant row has `organization_id`; children reference parents by
   `(id, organization_id)` composite foreign keys, so a cross-tenant reference is impossible even with an
   application bug; row-level security filters every tenant table by `app.organization_id`, set per transaction.
3. **Immutable versions**: each save of a page, case, workflow… adds an `asset_version` row with the full snapshot in
   the 0.1.0 YAML shape and its SHA-256. `change_set` groups versions for review (ADR-0007); self-approval is
   refused by a constraint. Versions and the audit log are append-only (triggers).
4. **No secrets in the database**: passwords, basic-auth and integration tokens are `*_secret_ref` columns pointing
   into the secrets manager. Evidence files live in object storage; rows hold the key, size and SHA-256.
5. **Steps and data rows** are rows (ordered, referenceable from results), with the serialized step and the free-form
   data fields as JSONB, so the 24 step actions and any data columns need no schema change.

## Consequences

- YAML import and export map one-to-one through the business keys; the migration utility (backlog §5) reads 0.1.0
  projects and writes rows plus version 1 snapshots.
- The application must set `app.organization_id` on every transaction; platform jobs use a `BYPASSRLS` role.
- `user_account` is global (one person, several organisations) and is scoped by `membership` in the application.
