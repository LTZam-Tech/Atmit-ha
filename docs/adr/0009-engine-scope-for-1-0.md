# ADR-0009: Which test engines ship in 1.0

- Status: **Accepted: option B, web + API in 1.0** (product owner decision, 2026-11-18)
- Date: 2026-11-18

## Context

Backlog §6–§9 add API, mobile (Appium) and performance (k6) engines to the existing web engine. Together mobile and
performance are about 43 person-weeks and 2–3 months of calendar. The release priority in the backlog puts engine
expansion last.

## Options

| Option | 1.0 | Later |
| --- | --- | --- |
| A. All four engines | Web, API, mobile (Android), performance | iOS execution |
| B. **Web + API** | Web, API | Mobile (1.1), performance (1.1 or 1.2) |
| C. Web only | Web | Everything else |

## Recommendation

**Option B.** API testing reuses most of the web engine's model (steps, data rows, variables, reports) and is the most
requested companion to UI tests; it also proves the engine contract before mobile and performance use it. Releasing 1.0
about 2–3 months earlier puts the platform in front of real clients sooner.

## Consequences if accepted

- The engine contract (ADR to follow) is designed for all four engines now, implemented for web and API first.
- Mobile and performance stay "new development" in all product material until they ship (backlog scope boundaries).
