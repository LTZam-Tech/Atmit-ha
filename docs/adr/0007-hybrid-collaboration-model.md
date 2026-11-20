# ADR-0007: Central and local collaboration model

- Status: **Accepted: option B, central-first with offline drafts** (product owner decision, 2026-11-18)
- Date: 2026-11-18

## Context

Backlog §15 asks for central and local workspaces, controlled synchronisation, immutable versions, change sets, conflict
detection, merge with approval, offline changes and local execution when the centre is down, with client data kept under
client control. Full offline editing with merge is the hardest part of the programme (estimate: 16–36 person-weeks).

## Options

| Option | Behaviour | Effort (workstream 15) |
| --- | --- | --- |
| A. **Central-first** | All edits on the central server; local agents only execute; read-only cache offline | ~10 person-weeks |
| B. **Central-first with offline drafts** | Offline, testers edit drafts locally; on reconnect each draft becomes a change set that a reviewer approves; conflicts are shown, never auto-merged | ~18–24 person-weeks |
| C. Full peer synchronisation | Both sides edit freely; automatic three-way merge | ~30–36 person-weeks, highest risk |

## Recommendation

**Option B for 1.0.** It keeps the backlog's promises (offline work, approval, provenance, local execution) without
automatic merging of test assets, which is where silent data loss happens. Option C can follow if real usage needs it.

## Consequences if accepted

- Every case and page version is immutable and has an author; a change set references the version it started from.
- Conflict = the base version changed since the draft started; resolution is a reviewer decision in the UI.
