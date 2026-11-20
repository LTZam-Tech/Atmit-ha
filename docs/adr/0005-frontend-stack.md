# ADR-0005: Frontend stack for the platform UI

- Status: **Accepted: Angular** (product owner decision, 2026-11-18; see Outcome)
- Date: 2026-11-18

## Context

The 0.1.0 panel is Preact + htm templates without a build step (326 KB, 17 modules). The backlog (§2, §3) asks for a full
IltizamTech design system, an application shell, admin screens, permission-aware navigation, Arabic/English with RTL,
accessibility and component tests. The no-build approach has no types, no component tests and no tree-shaking.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. **React + TypeScript + Vite**, accessible headless components (for example Radix), CSS design tokens | Largest hiring pool and ecosystem; mature accessibility and RTL support; component testing (Testing Library) | 0.1.0 screens are ported, not reused as-is |
| B. Preact + TypeScript + Vite (keep the library, add a build) | Closest to 0.1.0 code; small bundle; can use React libraries through `preact/compat` | Smaller ecosystem; compat edge cases in component libraries |
| C. Keep Preact + htm, no build | No migration | Does not meet the backlog's testing, typing and design-system needs |

## Recommendation

**Option A.** Port screen logic and the `i18n-ar.js` dictionary from 0.1.0, screen by screen, behind the new shell. The
effort estimate assumed a rebuild; option B saves about 10% of the frontend figure, option A lowers hiring risk.

## Outcome

The product owner chose **Angular** (option not listed above): the same framework as IltizamTech's other products
(Inspection admin and facility-owner apps use Angular 19), so teams, components and reviews are shared across products.
Angular + TypeScript + Angular CDK for accessible primitives; CSS design tokens for the IltizamTech design system;
`@angular/localize` or a runtime dictionary for Arabic/English with RTL. Screen logic and `i18n-ar.js` strings are ported
from 0.1.0 screen by screen. Option A's other consequences (new `web/` package with its own build, component tests in CI)
apply unchanged.

## Consequences if accepted

- New `web/` package with its own build; the 0.1.0 panel keeps working until each stage is replaced.
- Frontend unit and component tests become part of CI.
