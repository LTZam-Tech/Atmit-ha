# ADR-0013: .NET platform server — framework, data access and migrations

- Status: Accepted
- Date: 2026-11-18

## Context

ADR-0006 chose .NET for the platform server. IltizamTech's other backend (Inspection) uses ABP Framework 10.4 on
net10.0 with SQL Server. Atimtha's schema (ADR-0012) relies on PostgreSQL features ABP's EF Core conventions do not
drive: composite tenant foreign keys, row-level security, enums, append-only triggers. The backlog asks for a modular
monolith with clear domain boundaries and no unnecessary services.

## Decision

- **net10.0, ASP.NET Core minimal APIs**, one host (`platform/src/Atimtha.Api`), modules as folders with their own
  endpoints, entities and services: `Identity` (users, memberships, permissions), `Workspaces` (workspaces, projects,
  environments), later `TestAssets`, `Execution`, `Evidence`, `Integrations`. A module talks to another only through
  its public service interface.
- **Not ABP.** Its tenant model, permission tables and EF migrations would compete with ADR-0012's schema. What ABP
  would give (permissions, audit, settings, feature flags) is small enough to build on the schema directly.
- **EF Core 10 + Npgsql** for data access, mapped onto the existing tables (snake_case columns, PostgreSQL enums).
- **SQL migrations are the source of truth** (`db/migrations/*.up.sql`), applied in order by the platform's migration
  runner (`Atimtha.Api migrate`) and recorded in `atimtha.schema_migration`. No EF-generated migrations: RLS policies,
  triggers and composite keys stay readable SQL that DBAs can review.
- **Tenancy**: every request resolves one organisation (`X-Atimtha-Organization: <key>` header, or the token's `org`
  claim); a connection interceptor sets `app.organization_id` on every opened connection, so PostgreSQL row-level
  security filters every query. The API connects with a role that does **not** bypass RLS; the migration runner uses a
  separate owner role.
- **Authentication**: OpenID Connect / JWT bearer from the client's identity provider (backlog §13 SSO foundation).
  A development-only header login exists for local Compose and refuses to start outside the Development environment.
- **Authorisation**: permission keys (`project.edit`, `execution.run`…) granted through roles and memberships in the
  database; each endpoint requires one permission.
- **Errors and API standards**: RFC 9457 problem details, `/api/v1` prefix, OpenAPI document, JSON logs with a
  trace id per request, `/health/live` and `/health/ready`.
- **Audit**: every write adds an `audit_log` row in the same transaction.

## Consequences

- The platform does not re-implement the case model: test assets are stored as rows plus JSON and validated by the
  engine (ADR-0014).
- Developers need the .NET 10 SDK; CI builds the platform in its own workflow.
