# Atimtha execution agent

Runs Atimtha jobs next to the applications under test and reports results to the platform (backlog §10,
ADR-0014, ADR-0015). It only calls out: no inbound port, works from private client networks.

## Start

1. An organisation administrator creates the agent: `POST /api/v1/agents { "name": "uat-runner-1", "kind": "private", "engines": ["web", "api"] }`.
   The answer shows the token **once** (`atk_…`).
2. On the agent machine (this repository, `npm ci`, `npx playwright install chromium`):

```bash
ATIMTHA_PLATFORM_URL=https://atimtha.client.local ATIMTHA_AGENT_TOKEN=atk_… npm run agent
```

| Variable | Meaning |
| --- | --- |
| `ATIMTHA_PLATFORM_URL` | Platform address (HTTPS outside local development) |
| `ATIMTHA_AGENT_TOKEN` | The agent token |
| `ATIMTHA_AGENT_ENGINES` | Engines this machine runs (default `web,api`; never more than the agent was created with) |
| `ATIMTHA_POLL_SECONDS` | Seconds between job checks when idle (default 5) |
| `ATIMTHA_SECRETS_DIR` | Folder of secret files for `vault:file/<name>` references |
| `BROWSER_CHANNEL`, `PLAYWRIGHT_BROWSERS_PATH` | Offline browsers (as in 0.1.0) |

## Secrets

Jobs carry **references**, never passwords. Supported today: `vault:env/<NAME>` (an environment variable of the agent)
and `vault:file/<name>` (a file in `ATIMTHA_SECRETS_DIR`, e.g. a mounted Docker secret). A secrets-manager client plugs
into `agent/secrets.ts`.

## What it does per job

claim → check contract, engine and expiry → write the project snapshot as `apps/job-<id>/` with a `secrets.yml` built
from the resolved references → run `playwright test` (cases and workflows) with `reporters/agent-reporter.ts` →
stream `test.finished` events → send `job.finished` with counts → delete the project folder, its secrets and saved
sessions. Cancelling from the platform stops the run within one heartbeat (15 s).
