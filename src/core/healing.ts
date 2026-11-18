/**
 * Self-healing governance (backlog §6: "proposed locator fixes cannot silently hide application defects;
 * preserve the original failure and report retry and healing outcomes separately"; ADR-0011).
 *
 * Three things can heal during a run:
 *   fallback-locator   the element's primary locator failed, a backup locator found it
 *   ready-element      the page's "ready when" element was missing, the page was recognised by other elements
 *   navigation-route   the page's address did not show the page, the navigation map reached it
 *
 * Policy — app.yml `run.healing`, or HEALING=pass|flag|off for one run:
 *   pass  (default)  heal and go on. A CHECK step (visible, text, value…) that only passes because a backup
 *                    locator found a different element FAILS: an assertion on a substitute element proves nothing.
 *   flag             heal and go on, so the rest of the test still runs, but the test FAILS at the end
 *                    with every heal and its original failure listed. For release gates.
 *   off              no healing at all: the original failure stops the test.
 *
 * Every heal is recorded as a structured `healing` annotation (plus the 0.1.0 `or-healed` text, which the
 * panel's "What the run found" still reads).
 */
import { test } from '@playwright/test';

export type HealingPolicy = 'pass' | 'flag' | 'off';
export type HealKind = 'fallback-locator' | 'ready-element' | 'navigation-route';
/** what the healed lookup was for: a check step is an assertion; an action or navigation only gets the test there */
export type HealPurpose = 'check' | 'action' | 'navigation';

export interface HealEvent {
  kind: HealKind;
  /** page or page.element */
  target: string;
  purpose: HealPurpose;
  /** why the original lookup failed — kept so the real problem is never lost */
  original: string;
  /** what was used instead */
  healedBy: string;
  /** where to fix it */
  fix: string;
}

export const HEALING_POLICIES: readonly HealingPolicy[] = ['pass', 'flag', 'off'];

/** the policy for this run: HEALING env var, then app.yml run.healing, then "pass" */
export function healingPolicy(fromApp?: string): HealingPolicy {
  const v = (process.env.HEALING ?? fromApp ?? 'pass').toLowerCase();
  return (HEALING_POLICIES as readonly string[]).includes(v) ? (v as HealingPolicy) : 'pass';
}

/** one line for the report and the legacy `or-healed` annotation */
export const describeHeal = (e: HealEvent) =>
  `${e.target}: ${e.original} → healed by ${e.healedBy}${e.purpose === 'check' ? ' (during a check)' : ''}. ${e.fix}`;

/**
 * Record a heal on the running test (no-op outside a test, e.g. in the harvester).
 * `legacyText` = the exact 0.1.0 `or-healed` sentence: the panel's "Self-healing during the run" fixes parse it.
 */
export function recordHeal(e: HealEvent, legacyText?: string): void {
  try {
    const info = test.info();
    const json = JSON.stringify(e);
    if (info.annotations.some((a) => a.type === 'healing' && a.description === json)) return;
    info.annotations.push({ type: 'healing', description: json });
    info.annotations.push({ type: 'or-healed', description: legacyText ?? describeHeal(e) });
  } catch {
    /* outside a test */
  }
}

/** the heals recorded on a test, from its annotations */
export function healsOf(annotations: { type: string; description?: string }[]): HealEvent[] {
  return annotations.filter((a) => a.type === 'healing').flatMap((a) => {
    try { return [JSON.parse(a.description ?? '') as HealEvent]; } catch { return []; }
  });
}

/**
 * Should a test that otherwise passed fail because of its heals?
 * Returns the failure message, or undefined when the heals are acceptable under the policy.
 */
export function healingVerdict(heals: HealEvent[], policy: HealingPolicy): string | undefined {
  if (!heals.length) return undefined;
  const blocking = policy === 'flag' ? heals : heals.filter((h) => h.purpose === 'check');
  if (!blocking.length) return undefined;
  const why = policy === 'flag'
    ? 'healing policy is "flag": a test that needed self-healing does not pass'
    : 'a check passed only because self-healing found a substitute element';
  return `[Healing] The test passed only through self-healing (${why}). Original failure(s):\n` +
    blocking.map((h) => `  • ${describeHeal(h)}`).join('\n');
}
