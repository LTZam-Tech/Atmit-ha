# ADR-0011: Self-healing governance

- Status: Accepted (implements backlog §6); the default policy is open to product-owner review
- Date: 2026-11-18

## Context

0.1.0 heals in three places: a backup locator when the primary fails (`SmartOR.el`), recognising a page by other
elements when its "ready when" element is missing (`waitReady`), and reaching a page through the navigation map when
its address does not show it (`UI.open`). Each heal let the test pass with only a warning string. Two problems:

1. A **check** that resolves through a backup locator can pass on a different element (for example a "Total" label
   found by text after its test id disappeared), so a real defect is hidden.
2. The original failure was reduced to a sentence, and healed passes were counted as ordinary passes.

Backlog §6: "proposed locator fixes cannot silently hide application defects; preserve the original failure and report
retry and healing outcomes separately".

## Decision

`src/core/healing.ts` defines a run-level policy, set in `app.yml` (`run.healing`) or with `HEALING=` for one run:

| Policy | Heal during an action or navigation | Heal during a check (verify steps and `save`) |
| --- | --- | --- |
| `pass` (default) | allowed, test can pass | **test fails** at the end with the original failure |
| `flag` | test keeps running, **fails** at the end | **fails** at the end |
| `off` | no healing: the original failure stops the test | no healing |

- Every heal is a structured `healing` annotation: kind, target, purpose, **original failure**, what healed it, where
  to fix it. The 0.1.0 `or-healed` sentence is kept word for word, because the panel's one-click fixes parse it.
- The `healingGate` auto fixture applies the policy after the test body, so the rest of the test still runs and
  reports everything it finds.
- Report: failures from the gate get the category **Self-healing**; each test card lists its heals with the original
  failure; the run summary adds `healed` (passed tests that needed healing) and `healingFailed`. `passed` keeps its
  0.1.0 meaning so pass-rate trends stay comparable; `flaky` (passed after retry) stays separate.
- Radio and checkbox groups that fell back silently in 0.1.0 now record their heal too.

## Consequences

- Behaviour change: under the default, a check that passed only through a backup locator now fails. Projects that
  relied on that can set `run.healing` explicitly, but should fix the locator.
- CI release gates can use `HEALING=flag`; exploratory local runs can keep `pass`.
- The exported standalone Playwright project still uses `.or()` fallbacks without governance (follow-up).
- Tests: `tests/unit/healing.test.ts` (written, not run yet).
