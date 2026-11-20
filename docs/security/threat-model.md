# Atimtha threat model

- Version: 1 (Phase 0), 2026-11-18
- Scope: Atimtha 0.1.0 as built (local Control Panel + Playwright framework) and the target platform's new attack surface
- Method: STRIDE per trust boundary; each threat has a status from the security baseline taxonomy:
  **Open** → **Implemented** (code changed) → **Tested** (automated test) → **Verified** (independent check) → or **Accepted risk** (risk owner only)
- Backlog reference: §13 "Conduct a threat model for the platform and execution architecture"

## 1. What we protect

| Asset | Where it lives today | Why it matters |
| --- | --- | --- |
| Credentials of client test users and basic-auth | `apps/<app>/secrets.yml`, `${ENV}` on CI | Access to client UAT systems |
| Saved browser sessions | `.auth/<app>/<user>.json` | Same as the password, until they expire |
| Client application data in evidence | `reports/` screenshots, videos, traces | May show personal or confidential data |
| Test assets (pages, cases, workflows) | `apps/<app>/` in Git | Client IP; reveals the application's structure |
| Branding (logos, client names) | `branding/profiles.yml` | Client confidentiality |
| The tester's machine | — | The panel can start browsers and run scripts |
| Source code and releases | GitHub `LTZam-Tech/Atmit-ha` | Supply chain of everything built on it |

## 2. Trust boundaries (0.1.0)

1. **Browser ↔ Control Panel** (`127.0.0.1:4400`): any web page the tester opens shares the browser with the panel.
2. **Panel ↔ child processes**: jobs run with the tester's OS rights; arguments come from API requests.
3. **Atimtha ↔ application under test**: automation drives client sites, often UAT behind VPN.
4. **Workspace ↔ Git / GitHub**: what is committed may become visible to everyone with repo access (the repo is public).
5. **Project zip import**: archives from other people are extracted into `apps/`.
6. **CI ↔ secrets**: pipeline variables become environment variables of test runs.

## 3. Threats in 0.1.0

| # | STRIDE | Threat | Status | Control / next step |
| --- | --- | --- | --- | --- |
| T1 | Spoofing, Tampering | A web page calls the panel API through DNS rebinding or a cross-site request and starts jobs, imports projects or commits | **Tested** | Host allowlist, same-origin and JSON-only checks (`panel/security.ts`, ADR-0002, 10 unit tests, live checks returned 421/403/415) |
| T2 | Information disclosure | Panel commit pushes credentials or unrelated files to Git (`git add -A`) | **Tested** | Commits only `apps/` and `branding/`, by explicit path; blocks secret file names, keys and tokens, literal passwords in `app.yml`, and any password from `secrets.yml` (`panel/git-guard.ts`, ADR-0004, 7 unit tests) |
| T3 | Information disclosure | Credentials typed into a case or recorded journey | **Implemented** (0.1.0) | Recorder writes known users as `{{user.<key>.password}}`; the commit check above catches real passwords that slip into files |
| T4 | Tampering, Elevation | A malicious project zip writes outside `apps/<key>/` (zip-slip), overwrites a project, or is a zip bomb | **Implemented** | 0.1.0 path and key checks, plus `checkZip` (`panel/limits.ts`) before anything is written: 50 MB archive, 5,000 files, 200 MB extracted, 50 MB per file, 200× expansion ratio, no absolute or `..` paths, every file inside the project folder. Unit tests written incl. a crafted traversal entry (`tests/unit/limits.test.ts`), not yet run |
| T5 | Denial of service | Very large request bodies exhaust memory (`readBody` had no limit) | **Implemented** | `readLimitedBody`: 2 MB per request, 70 MB for project imports, answers 413; invalid JSON now answers 400 instead of being read as empty. Unit tests written, not yet run |
| T6 | Elevation | Request values reach child processes as arguments | **Implemented** | `spawn` with an argument array, never a shell; plus `safeArg` on the three values used as standalone arguments (journey name, start address, collect address): no leading `-`, no control characters, length limit. Unit tests written, not yet run |
| T7 | Information disclosure | Static file routes serve files outside their folder | **Implemented** | `isInside` compares whole path segments, so a sibling folder with the same prefix no longer matches. Unit tests written, not yet run |
| T8 | Information disclosure | Evidence (screenshots, video, trace) shows client personal data and is shared with the report | **Open** | Report retention is 50 runs; no masking. Next (backlog §11, §13): masking rules, evidence permissions in the platform |
| T9 | Tampering | Script injection through test data shown in the Smart Report | **Implemented** (0.1.0) | Report escapes HTML (`esc`) and embeds data with `<` escaped. Integration test written (`tests/integration/report-xss.test.ts`: payloads in title, tags, steps, saved values, heals, error, last page), not yet run |
| T10 | Information disclosure | Plain-text `secrets.yml` and session files on the tester's disk | **Accepted risk (proposed)** | Same exposure as any local credential file; risk owner to confirm. Platform: secrets vault (backlog §13) |
| T11 | Tampering | Compromised npm dependency, leaked secret in history, unknown components | **Implemented** | `.github/workflows/security.yml` on every push: `npm audit --audit-level=high`, gitleaks over the full Git history, CycloneDX SBOM kept 90 days as a build artifact. Not yet run on GitHub |
| T12 | Repudiation | No record of who changed a case or ran a suite | **Open** | Git history only. Platform: audit log (backlog §4, §5) |
| T13 | Information disclosure | Public GitHub repository exposes client project files | **Open** | `LTZam-Tech/Atmit-ha` is public. Client projects (`apps/<client>/`) should live in private client repositories; decide before client work is committed |

## 4. New attack surface in the target platform

These enter with the backlog's platform work and must be designed in, not added later.

| Area | Main threats | Required controls (backlog) |
| --- | --- | --- |
| Accounts and sessions | Credential stuffing, session theft, CSRF | Secure sessions, MFA and SSO foundations, CSRF protection (§13) |
| Multi-tenancy | One client reading another's projects or evidence | Organisation and workspace isolation in every query, resource-level authorisation, isolation tests (§4, §5, §16) |
| Execution agents | Rogue agent, stolen agent credential, agent used to run arbitrary commands | mTLS, short-lived signed job tokens, revocation, outbound-only private agents, no remote shell (§10) |
| Job packages | Tampered test package executed on a client network | Signed execution packages, verified before run (§13) |
| Evidence storage | Bulk download of client screenshots | Encryption at rest, evidence permissions, retention (§11, §13) |
| Integrations | Leaked Jira / Azure DevOps / TestRail tokens | Credentials in the secrets manager, scoped tokens, integration logs without secrets (§14) |
| Performance engine | Uncontrolled load against a client environment | Load limits, approvals, environment allowlist (§9) |
| Synchronisation | Merge that silently overwrites another tester's changes or injects content | Immutable versions, change sets, provenance, approval (§15) |

## 5. Next actions

1. Run and pass the new tests for T4–T7 and the security workflow (T11); then mark them Tested.
2. Run the T9 report XSS test.
3. Decide where client projects live (T13) and confirm the T10 accepted risk.
4. Revisit this model when the target architecture (agents, tenancy) is accepted.
