# ADR-0006: Backend stack and shape

- Status: **Accepted: option B, .NET** (product owner decision, 2026-11-18; see Outcome)
- Date: 2026-11-18

## Context

The backlog (§4, §5, §10) asks for accounts, RBAC, tenant isolation, versioning, audit, execution APIs, a job queue and
agents, and says: no unnecessary microservices, a modular architecture with clear domain boundaries. The engine
(collection, runner, export) is TypeScript on Node and must keep working.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. **Node.js + TypeScript modular monolith** (for example Fastify or NestJS), PostgreSQL, RabbitMQ | Same language as the engine and the 0.1.0 model, so validation and types are shared; one deployable | Team needs strong TypeScript backend discipline (module boundaries enforced by lint rules) |
| B. .NET or Java backend, Node only for the engine | Strong enterprise frameworks | Two languages; the case model and validation would be duplicated or wrapped |
| C. Microservices per domain | Independent scaling | Explicitly ruled out by the backlog for this stage |

## Recommendation

**Option A**: one backend process with modules per bounded context (identity and access, workspace and projects, test
assets, execution, evidence and reports, integrations), PostgreSQL as the only transactional store, RabbitMQ for jobs,
agents as a separate deployable. Module boundaries checked in CI (no imports across module internals).

## Outcome

The product owner chose **.NET** for the platform server, matching IltizamTech's other backends (net10.0). The split:

- **Platform server (.NET 10, ASP.NET Core)**: one modular monolith — identity and access, workspaces and projects,
  test assets, execution orchestration, evidence and reports, integrations. PostgreSQL, RabbitMQ. See ADR-0013.
- **Test engine and execution agents (Node + TypeScript)**: `src/core` stays the engine; agents run it. The platform
  and the agents talk only through the versioned job and result contract (ADR-0014), so the case model is not
  duplicated in C#: the platform stores steps as JSON and validates them by calling the engine's validator on the agent
  side, plus its own structural checks.

The cost noted under option B (two languages) is accepted; the contract keeps it to one seam.

## Consequences if accepted

- `src/core` becomes the engine package shared by the backend and the agents.
- The API is versioned (`/api/v1`) and documented with OpenAPI from the start.
