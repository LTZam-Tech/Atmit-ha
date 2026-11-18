# Architecture decision records

Format and rules: [ADR-0001](0001-record-architecture-decisions.md). Decisions 0005–0010 were made by the product owner
on 2026-11-18; the resulting design is in the [target architecture](../architecture/target-architecture.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-panel-request-guard.md) | Guard the local panel API by Host, Origin and body type | Accepted |
| [0003](0003-unit-tests-with-node-test.md) | Unit and integration tests with node:test and tsx | Accepted |
| [0004](0004-panel-git-commit-policy.md) | Panel commits project files only, by explicit path, after a secret check | Accepted |
| [0005](0005-frontend-stack.md) | Frontend stack: **Angular** | Accepted |
| [0006](0006-backend-stack.md) | Backend: **.NET** platform; Node + TypeScript for the engine and agents | Accepted |
| [0007](0007-hybrid-collaboration-model.md) | Collaboration: central-first with offline drafts as reviewed change sets | Accepted |
| [0008](0008-deployment-targets.md) | Deployment at 1.0: Docker Compose plus offline bundle | Accepted |
| [0009](0009-engine-scope-for-1-0.md) | Engines at 1.0: web + API; mobile and performance in 1.1 | Accepted |
| [0010](0010-first-integration.md) | First integration: Jira, unless the pilot client uses another tool | Accepted |
| [0011](0011-self-healing-governance.md) | Self-healing governance: pass / flag / off; a check never passes on a substitute element | Accepted |
| [0012](0012-database-tenancy-and-keys.md) | Database: UUID keys with 0.1.0 keys kept, three-layer tenant isolation, immutable versions | Accepted |
| [0013](0013-dotnet-platform-architecture.md) | .NET platform: ASP.NET Core minimal APIs, EF Core + Npgsql, SQL migrations, RLS tenancy, OIDC, not ABP | Accepted |
| [0014](0014-engine-agent-contract.md) | Platform ↔ agent ↔ engine job and result contract v1 | Accepted |
