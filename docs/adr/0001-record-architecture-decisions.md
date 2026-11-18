# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-11-18

## Context

The backlog (§1) asks for architecture decision records for every major technical decision, and the platform will be built
by several teams over about a year. Decisions made in chat or meetings get lost.

## Decision

Each significant decision is a numbered Markdown file in `docs/adr/`, using this template:

```
# ADR-NNNN: <title>
- Status: Proposed | Accepted | Superseded by ADR-XXXX | Rejected
- Date: YYYY-MM-DD
- Deciders: <names or roles>   (optional)
## Context      — the forces and facts at play
## Decision     — what we do, in active voice
## Consequences — what becomes easier, harder, or must be done next
## Alternatives — options considered and why they lost (optional)
```

An ADR is never edited after it is Accepted, except to change its status. A changed decision is a new ADR that supersedes
the old one.

## Consequences

- Reviewers can check a pull request against the ADRs it touches.
- "Proposed" ADRs list the decisions the product owner and architect still have to make.
