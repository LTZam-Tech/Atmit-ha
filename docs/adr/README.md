# Architecture decision records

Format and rules: [ADR-0001](0001-record-architecture-decisions.md). **Proposed** ADRs are decisions waiting for the
product owner or architect; they block the target architecture document until accepted or changed.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-panel-request-guard.md) | Guard the local panel API by Host, Origin and body type | Accepted |
| [0003](0003-unit-tests-with-node-test.md) | Unit and integration tests with node:test and tsx | Accepted |
| [0004](0004-panel-git-commit-policy.md) | Panel commits project files only, by explicit path, after a secret check | Accepted |
| [0005](0005-frontend-stack.md) | Frontend stack: React + TypeScript + Vite (recommended) | Proposed |
| [0006](0006-backend-stack.md) | Backend: Node + TypeScript modular monolith, PostgreSQL, RabbitMQ (recommended) | Proposed |
| [0007](0007-hybrid-collaboration-model.md) | Collaboration: central-first with offline drafts as reviewed change sets (recommended) | Proposed |
| [0008](0008-deployment-targets.md) | Deployment at 1.0: Docker Compose plus offline bundle (recommended) | Proposed |
| [0009](0009-engine-scope-for-1-0.md) | Engines at 1.0: web + API; mobile and performance later (recommended) | Proposed |
| [0010](0010-first-integration.md) | First integration: the pilot client's tool, else Jira (recommended) | Proposed |
