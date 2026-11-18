# ADR-0002: Guard the local panel API by Host, Origin and body type

- Status: Accepted
- Date: 2026-11-18

## Context

The 0.1.0 panel (`panel/server.ts`) binds to `127.0.0.1:4400` and has no authentication. It can start browsers, run
scripts, write project files and commit to Git. Binding to localhost does not stop a web page in the tester's own browser
from calling it:

1. **DNS rebinding** — an attacker's domain resolves to 127.0.0.1; the attacker's page then calls the panel as
   "same-origin" under its own host name and can read the responses.
2. **Cross-site requests** — any page can submit a form or `fetch` to `http://localhost:4400`. Responses cannot be read
   without CORS, but a write (start a run, import a project, commit) would still execute.

PRD NFR-04 records this gap.

## Decision

`panel/security.ts` checks every request before routing:

| Check | Blocks | Answer |
| --- | --- | --- |
| `Host` must be `localhost`, `127.0.0.1` or `[::1]` with the panel port | DNS rebinding | 421 |
| `Origin`, when present, must be the panel's own origin; `Origin: null` is refused | Cross-site and sandboxed writes | 403 |
| `Sec-Fetch-Site: cross-site` or `same-site` is refused, except a top-level GET navigation to a non-`/api/` page | Cross-site reads, images, scripts | 403 |
| `POST`, `PUT`, `PATCH`, `DELETE` must send `Content-Type: application/json` | HTML form posts, which cannot set this type cross-site without a CORS preflight the panel never approves | 415 |

Every response also carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (the run history frames
the panel's own reports), `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.

## Consequences

- No change for testers: the panel UI already sends JSON through one helper (`panel/app/core.js`), and links that open
  the panel from another site still work.
- Scripts or tools that call the panel API must send a local `Host` header and JSON bodies.
- Covered by `tests/unit/panel-security.test.ts`.

## Alternatives

- **Per-session token in a header or cookie.** Rejected for 0.1.0: the remaining threat is other processes running as the
  same OS user, which can read the project files and the token directly. The platform's real authentication (accounts,
  sessions, RBAC) belongs to the backlog's backend work (§4, §13) and will replace this guard for the server edition.
- **CORS configuration.** Not needed: the panel never answers cross-origin requests, so no CORS headers are sent.
