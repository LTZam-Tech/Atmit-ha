# ADR-0006: Backend stack and shape

- Status: **Proposed**, needs architect decision
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

## Consequences if accepted

- `src/core` becomes the engine package shared by the backend and the agents.
- The API is versioned (`/api/v1`) and documented with OpenAPI from the start.
