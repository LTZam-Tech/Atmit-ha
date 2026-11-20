# ADR-0004: The panel commits project files only, by explicit path, after a secret check

- Status: Accepted
- Date: 2026-11-18

## Context

In 0.1.0 the panel's Git button ran `git add -A`, then refused the commit only if a file named `secrets.yml`, `.env*` or
under `.auth/` was staged. Every other untracked file in the workspace was committed: scratch files, exported zips,
anything with a password that did not match those names. The backlog (§14) asks for better commit controls and secret
protection, and the GitHub repository is public (threat model T2, T13).

## Decision

`panel/git-guard.ts` decides what the panel commits:

1. **Area**: only changes under `apps/` and `branding/` (what testers create in the panel). Other changes are listed as
   "Use your Git client" and left alone.
2. **Explicit paths**: the chosen files are staged and committed by path (`--pathspec-from-file`, literal pathspecs),
   so anything already staged by someone else is not swept into the commit.
3. **Secret check, by name and content**: secret file names (`secrets.yml`, `.env*`, `.auth/`, keys and keystores,
   `.npmrc`, `credentials`), private keys, AWS / GitHub / Slack tokens, cloud-browser keys, literal passwords in
   `app.yml`, and any password found in a project's `secrets.yml`.
4. **Block, do not skip**: one suspicious project file blocks the whole commit and the panel names the file and reason.

Case files may hold deliberately wrong passwords as negative test data, so the literal-password rule applies to
`app.yml` only; a real password in a case is still caught by the `secrets.yml` comparison.

## Consequences

- Testers can no longer commit code or settings changes from the panel; engineers use their Git client for those.
- Covered by `tests/unit/git-guard.test.ts`.
- Push, pull and branches remain outside the panel until the integration work (§14).
