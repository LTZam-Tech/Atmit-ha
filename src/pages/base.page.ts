/**
 * BasePage — every Page Object gets a typed Smart OR for its page key.
 * Page Objects contain ACTIONS only. Locators live in apps/<app>/or/*.page.yml, assertions live
 * in tests (the only exception is assertLoaded(), which checks page identity).
 *
 *   import type { ORRegistry } from '../or/or.types.gen';
 *   class LoginPage extends BasePage<ORRegistry, 'login'> { ... }
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { SmartOR } from '../core/or/resolver';
import { step } from '../utils/steps';
import { withBaseQuery } from '../utils/url';
import { recordHeal } from '../core/healing';
import { waitForSpinners } from '../utils/settle';
import { environment, runConfig } from '../../config/environment';

type Args<T> = T extends undefined ? [] : [params: T];

export abstract class BasePage<R, K extends keyof R & string> {
  protected readonly or: SmartOR;

  constructor(readonly page: Page, readonly key: K) {
    this.or = new SmartOR(page, key);
  }

  /** Smart lookup — fallback + healing. Use for actions and positive checks. */
  el<E extends keyof R[K] & string>(name: E, ...params: Args<R[K][E]>): Promise<Locator> {
    return this.or.el(name, params[0] as Record<string, string> | undefined);
  }

  /** Primary locator only — use for NEGATIVE checks (toBeHidden, toHaveCount(0)). */
  strict<E extends keyof R[K] & string>(name: E, ...params: Args<R[K][E]>): Locator {
    return this.or.locator(name, params[0] as Record<string, string> | undefined);
  }

  async open(query = ''): Promise<void> {
    await openPage(this.page, this.or, query);
  }

  async waitUntilReady(): Promise<void> {
    await waitReady(this.or);
  }

  async assertLoaded(): Promise<void> {
    await step.verify(`${this.key} page is displayed`, () => this.waitUntilReady(), this.page);
  }
}

/** Shared by Page Objects and the no-code case runner */
export async function openPage(page: Page, or: SmartOR, query = ''): Promise<void> {
  const url = withBaseQuery((or.def.url ?? '/') + query, environment.baseURL);
  await step.navigate(`Open ${or.def.page} page (${url})`, async () => {
    await page.goto(url);
    await waitForSpinners(page, 15000);
    await waitReady(or);
  });
}

export async function waitReady(or: SmartOR): Promise<void> {
  const ready = or.def.readyWhen;
  if (!ready) return;
  const hint = `${or.def.page} page did not become ready: "${ready}" is not on the page at ${or.page.url()}. ` +
    `If it belongs to another page, the page was collected while the previous one was still showing — ` +
    `collect it again (Control Panel → Pages → 🩺 Check pages / ↻ Collect again) or pick another "ready when" element.`;
  let first: Error;
  try {
    await expect(await or.el(ready), hint).toBeVisible();
    return;
  } catch (e) { first = e as Error; }
  // healing policy "off": the original failure stands
  if (runConfig.healing === 'off') throw new Error(`${hint}\n${first.message}`);
  // self-healing: the page is recognised by its other elements (headings and fields first) → go on, and say so
  const seen = await recognise(or, ready);
  if (seen.length) {
    const msg = `${or.def.page}: "ready when" element "${ready}" was not on the page — recognised it by ${seen.join(', ')}. Fix it in Pages → 🩺 Check pages.`;
    recordHeal({
      kind: 'ready-element', target: or.def.page, purpose: 'navigation',
      original: `"ready when" element "${ready}" was not visible: ${first.message.split('\n')[0]}`,
      healedBy: `recognising the page by ${seen.join(', ')}`, fix: 'Fix it in Pages → 🩺 Check pages.',
    }, msg);
    return;
  }
  throw new Error(`${hint}\n${first.message}`);
}

/** names of the page's own elements that are visible now (at least 2, or 1 when the page has only 1–2) */
export async function recognise(or: SmartOR, except?: string): Promise<string[]> {
  const els = or.def.elements as Record<string, { control?: string; role?: string; href?: string }>;
  const rank = (n: string) => { const d = els[n]; return d.control === 'heading' || d.role === 'heading' ? 0 : ['textbox', 'textarea', 'select', 'button', 'datepicker', 'radiogroup', 'checkgroup', 'password'].includes(String(d.control)) ? 1 : d.control === 'link' || d.href ? 3 : 2; };
  const names = Object.keys(els).filter((n) => n !== except && !['alert', 'dialog'].includes(String(els[n].control)) && !/Close$/.test(n) && !JSON.stringify(els[n]).includes('{{')).sort((a, b) => rank(a) - rank(b));
  const need = names.length <= 2 ? 1 : 2;
  const seen: string[] = [];
  for (const n of names.slice(0, 10)) {
    if (rank(n) === 3 && seen.length === 0) continue; // menu links alone prove nothing — every page has them
    const loc = await or.el(n, {}, { timeout: 1500 }).catch(() => undefined);
    if (loc && (await loc.first().isVisible().catch(() => false))) seen.push(n);
    if (seen.length >= need) return seen;
  }
  return [];
}
