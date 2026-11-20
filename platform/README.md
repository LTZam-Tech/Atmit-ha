# Atimtha platform API (.NET)

The central control plane (ADR-0006, ADR-0013): one ASP.NET Core service on .NET 10 with PostgreSQL.
The test engine and execution agents stay in TypeScript (repository root); they talk to this API through the job
contract (ADR-0014).

## Run it locally (Docker Compose)

```bash
cd deploy/compose
cp .env.example .env        # change the passwords
docker compose up --build
```

Then, signed in through the **development login** (Development environment only):

```bash
curl -H "X-Dev-User: admin@atimtha.local" http://localhost:8080/api/v1/me
curl -H "X-Dev-User: admin@atimtha.local" -H "X-Atimtha-Organization: iltizamtech" http://localhost:8080/api/v1/workspaces
```

`tester@atimtha.local` is a Tester in the `qa` workspace only. OpenAPI: `http://localhost:8080/openapi/v1.json`.

## Run it from source

Needs the .NET 10 SDK and the Compose `postgres` service (or any PostgreSQL 15+ with the two roles from
`deploy/postgres/init-roles.sh`).

```bash
dotnet run --project platform/src/Atimtha.Api -- migrate   # apply db/migrations
dotnet run --project platform/src/Atimtha.Api              # http://localhost:5xxx
dotnet test platform/Atimtha.Platform.slnx
```

## Layout

| Path | Contents |
| --- | --- |
| `src/Atimtha.Api/Program.cs` | Host: logging, auth, tenancy, health, OpenAPI, routes |
| `src/Atimtha.Api/Infrastructure` | EF Core context and entities, tenant connection interceptor (RLS), SQL migration runner, audit, API helpers |
| `src/Atimtha.Api/Identity` | Permissions, access checks with workspace scope, tenant middleware, user linking, development login, `/me` |
| `src/Atimtha.Api/Workspaces` | `/workspaces`, `/workspaces/{key}/projects`, `/projects/{id}`, `/projects/{id}/environments` |
| `tests/Atimtha.Api.Tests` | Unit tests |
| `../db/migrations` | SQL schema (source of truth) |
| `../deploy` | Compose stack, database roles, development seed |

## API (v1, first module)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/me` | signed in |
| GET | `/api/v1/workspaces` | `project.view` |
| POST | `/api/v1/workspaces` | `workspace.manage` (organisation-wide) |
| GET / POST | `/api/v1/workspaces/{key}/projects` | `project.view` / `project.edit` in that workspace |
| GET / PATCH / DELETE | `/api/v1/projects/{id}` | `project.view` / `project.edit` (with `If-Match`) / `project.delete` (archives) |
| GET | `/api/v1/projects/{id}/environments` | `project.view` |
| PUT / DELETE | `/api/v1/projects/{id}/environments/{key}` | `project.edit` |

Every request outside `/api/v1/me` names its organisation with `X-Atimtha-Organization` (or the token's `org` claim).
Other organisations' data answers 404, never 403, so its existence is not revealed. Every change writes an audit row.
