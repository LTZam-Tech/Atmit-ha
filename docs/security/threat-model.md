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
| T4 | Tampering, Elevation | A malicious project zip writes outside `apps/<key>/` (zip-slip) or overwrites a project | **Implemented** (0.1.0) | Path normalisation and prefix check, key pattern check, overwrite needs confirmation, `secrets.yml` in the zip ignored. Next: unit test with a crafted zip; size and file-count limits (zip bomb) |
| T5 | Denial of service | Very large request bodies or archives exhaust memory (`readBody` has no limit) | **Open** | Local-only today (T1 blocks remote callers). Next: body size limit (for example 50 MB for imports, 1 MB otherwise) |
| T6 | Elevation | Request values reach child processes as arguments | **Implemented** (0.1.0) | `spawn` with an argument array, never a shell; page keys validated by pattern. Next: validate `path` and `name` arguments do not start with `-` |
| T7 | Information disclosure | Static file routes serve files outside their folder | **Implemented** (0.1.0) | `path.normalize` + prefix check. Next: compare with a trailing separator so a sibling folder with the same prefix cannot match |
| T8 | Information disclosure | Evidence (screenshots, video, trace) shows client personal data and is shared with the report | **Open** | Report retention is 50 runs; no masking. Next (backlog §11, §13): masking rules, evidence permissions in the platform |
| T9 | Tampering | Script injection through test data shown in the Smart Report | **Implemented** (0.1.0) | Report escapes HTML (`esc`) and embeds data with `<` escaped. Next: integration test with an XSS payload in a case title and data row |
| T10 | Information disclosure | Plain-text `secrets.yml` and session files on the tester's disk | **Accepted risk (proposed)** | Same exposure as any local credential file; risk owner to confirm. Platform: secrets vault (backlog §13) |
| T11 | Tampering | Compromised npm dependency or browser download | **Open** | Lockfile present; no dependency scanning or SBOM. Next (backlog §12): dependency and secret scanning, CycloneDX SBOM in CI |
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

1. Unit tests for T4 (crafted zip) and T9 (XSS payload in the report).
2. Body size limit (T5), argument validation (T6), path-prefix fix (T7).
3. Decide where client projects live (T13) and confirm the T10 accepted risk.
4. Add dependency scanning, secret scanning and an SBOM to CI (T11).
5. Revisit this model when the target architecture (agents, tenancy) is accepted.
