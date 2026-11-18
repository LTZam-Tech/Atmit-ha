# ADR-0008: Deployment targets for release 1.0

- Status: **Proposed**, needs product owner decision
- Date: 2026-11-18

## Context

Backlog §12 lists cloud, on-premises and offline packages, Docker Compose, and Kubernetes "if required by the target client
environment". Each extra target adds packaging, documentation and test runs (about 4–8 person-weeks each).

## Options

| Option | Targets at 1.0 |
| --- | --- |
| A. **Docker Compose everywhere** | One Compose package for cloud VMs and on-premises servers, plus an offline bundle (images saved to a file, no internet needed) |
| B. A + Kubernetes (Helm chart) | Adds a cluster target |
| C. Managed cloud only | Simplest, but fails restricted client networks |

## Recommendation

**Option A.** It covers cloud, on-premises and air-gapped clients with one artefact. Add a Helm chart (option B) when a
signed client requires Kubernetes.

## Consequences if accepted

- Every release produces versioned images, a Compose file, an offline bundle, an SBOM and an install guide.
- Installation without internet is part of release testing.
