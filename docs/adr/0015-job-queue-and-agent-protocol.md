# ADR-0015: Job queue in PostgreSQL and an HTTP agent protocol for 1.0

- Status: Accepted
- Date: 2026-11-18

## Context

Backlog §10 asks for "an execution queue using RabbitMQ or an approved equivalent", agent registration, heartbeats,
outbound-only private agents, recovery after disconnection, cancellation and no remote shell. ADR-0014 fixed the job and
event documents. Giving every private agent RabbitMQ credentials and network access to the broker is a second secured
channel to operate at client sites.

## Decision

1. **Queue = PostgreSQL** for 1.0: queued executions are rows; agents claim with `UPDATE … WHERE id = (SELECT … FOR
   UPDATE SKIP LOCKED LIMIT 1)`, so concurrent agents never take the same job, and row-level security limits an agent
   to its organisation. The platform uses it through `IJobQueue`; a RabbitMQ implementation can replace it later without
   changing the agent protocol. RabbitMQ stays in the Compose stack for that step.
2. **Agents speak HTTPS to the platform, outbound only** (`/api/agent/v1`): `POST /heartbeat` (version, engines;
   answers with jobs to cancel), `POST /jobs/claim` (204 or a job), `POST /jobs/{id}/events` (≤ 500 events per call;
   answers `cancel: true` when the run was cancelled).
3. **Agent identity**: an administrator creates the agent (`POST /api/v1/agents`); its token (`atk_…`, 256 random bits)
   is shown once and stored as SHA-256. Revoking clears the token and requeues the agent's unfinished jobs. mTLS client
   certificates are added in front of this later; the token stays the application identity.
4. **Recovery**: a maintenance service checks every minute; a job whose agent has been silent for 2 minutes is
   requeued once, then marked `error` ("the agent stopped responding"), which reports as infrastructure, never as an
   application failure. Silent agents are marked offline.
5. **No commands**: a job names an engine and carries data (ADR-0014); the agent runs only the engine's own runner.

## Consequences

- One fewer service to secure at client sites; the database is already backed up and monitored.
- Throughput is bounded by PostgreSQL row locking, far above 1.0 needs (hundreds of claims per second).
- Long-poll or server-sent events for instant pickup can be added; agents poll every few seconds today.
