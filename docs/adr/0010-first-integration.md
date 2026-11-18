# ADR-0010: First test-management / defect integration

- Status: **Accepted: Jira first** unless the first pilot client uses another tool (recommendation adopted, 2026-11-18)
- Date: 2026-11-18

## Context

Backlog §14 asks to define Jira, Azure DevOps and TestRail integrations and to publish execution results through approved
integrations. The estimate assumes one integration built end to end and the others defined (each further one about 4–6
person-weeks).

## Options

- **Jira** (Cloud and Data Center): most common defect tracker; issues from failed tests, results as comments or Xray /
  Zephyr test executions.
- **Azure DevOps**: common in government and Microsoft-centred clients; test plans and work items in one place.
- **TestRail**: test management only; no defect tracking.

## Recommendation

Build **the one the first pilot client uses**; if there is none yet, **Jira**. Define all three behind one integration
contract (publish run, create defect, link case) so the others are adapters.

## Consequences if accepted

- Integration credentials live in the platform's secrets store, never in project files.
- Each integration can be switched off by feature flag.
