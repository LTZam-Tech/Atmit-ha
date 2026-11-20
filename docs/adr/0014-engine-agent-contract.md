# ADR-0014: Contract between the platform, execution agents and test engines

- Status: Accepted (version 1 of the contract; fields may be added, never changed in meaning)
- Date: 2026-11-18

## Context

The platform is .NET (ADR-0006), the web engine is the 0.1.0 TypeScript code, and 1.0 adds an API engine (ADR-0009).
Agents run on central servers, testers' machines or private client networks (backlog §10) and must not accept
arbitrary commands. The platform and the engine must not each keep their own copy of the case model.

## Decision

1. **Agents pull work.** An agent opens an outbound connection (mTLS, ADR to follow for certificates), announces its
   capabilities (`engines: [web, api]`, browsers, max parallel jobs), and receives **jobs**. No inbound port is needed on
   private networks.
2. **A job is data, never a command.** Version 1 job document:

   ```json
   {
     "contract": "atimtha.job/1",
     "jobId": "uuid", "executionId": "uuid", "organizationId": "uuid",
     "engine": "web",
     "project": { "key": "demo", "snapshot": { "app": {}, "pages": [], "cases": [], "flows": [], "navigation": [], "messages": {} } },
     "environment": { "key": "uat", "baseURL": "https://…", "secretRefs": { "users.standard.password": "vault:…" } },
     "selection": { "cases": ["login"], "rows": ["TC-001"], "tags": ["@smoke"], "suite": null },
     "settings": { "locale": "ar", "workers": 2, "retries": 1, "healing": "pass", "testTimeoutSeconds": 60 },
     "token": "short-lived signed token scoped to this job",
     "expiresAt": "2026-11-18T12:00:00Z"
   }
   ```

   The snapshot uses the 0.1.0 YAML shapes, so the agent writes it as an `apps/<key>/` folder and runs the existing
   engine unchanged. The agent only ever starts the engine's own runner; there is no field that names a program or a
   shell command.
3. **Secrets travel as references.** The agent resolves `secretRefs` with its job token at run time; secrets are never in
   the job document, the logs or the results.
4. **Results stream back** as events: `job.started`, `test.finished` (title, case, row, status, category, duration,
   steps, healing events, discoveries), `evidence.uploaded` (object key, SHA-256), `job.finished` (counts as in the run
   summary). The platform writes them to `execution`, `test_result`, `healing_event`, `evidence`.
5. **Validation lives in the engine.** The platform stores steps and rows as JSON and checks structure; the engine's
   validator (`readCases`, `readFlows`, `readNavigation`) is the authority, run by an agent's `validate` job type or by
   the platform calling the engine package in a sandbox.
6. **Versioning**: `contract` names the major version. Agents state the versions they support; the platform sends a
   version both sides know.

## Consequences

- The 0.1.0 engine runs on agents with no change to its file formats.
- The API engine (1.0) uses the same job and result shape with `engine: "api"`.
- Contract schemas live in `contracts/` as JSON Schema (to add with the agent work) and are tested on both sides.
