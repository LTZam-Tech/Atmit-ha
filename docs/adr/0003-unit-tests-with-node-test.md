# ADR-0003: Unit-test Atimtha with node:test and tsx

- Status: Accepted
- Date: 2026-11-18

## Context

0.1.0 had no tests of Atimtha itself; `tests/` only holds the runners that execute the sample projects' YAML cases in a
browser. The backlog (§6, §16, Definition of Done) requires automated tests for every change and regression coverage of
all 0.1.0 capabilities.

## Decision

- Unit and module tests live in `tests/unit/**/*.test.ts` and run with Node's built-in runner through tsx:
  `npm run test:unit` (`node --import tsx --test`). No new dependency.
- Tests that need a real browser but test Atimtha's own modules (page collection, generators) live in
  `tests/integration/**/*.test.ts` and run with `npm run test:integration` (same runner, one file at a time). They start
  the bundled demo app on a free port and drive Chromium through the Playwright library.
- Playwright Test stays the runner for the no-code cases and end-to-end tests of applications under test. Its `testMatch` in `playwright.config.ts` does not pick
  up `tests/unit`, so the two suites stay separate.
- The bundled sample projects are regression fixtures: `tests/unit/sample-projects.test.ts` loads, validates and exports
  every project under `apps/`. The same projects will be the fixtures for the YAML-to-database migration.

## Consequences

- Fast feedback (the suite runs in seconds) without a browser.
- CI runs `npm run test:unit` and `npm run test:integration` after `npm run validate` in `.github/workflows/e2e.yml`.
- Frontend component tests need a separate decision once the frontend stack is chosen (see the estimate's open decisions).
