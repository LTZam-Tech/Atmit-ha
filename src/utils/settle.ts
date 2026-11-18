/**
 * Wait until a page has really finished: the network calms down, loading spinners / overlays are gone,
 * and the content stops changing (address, number of elements, main heading). Used before a page is
 * collected — a page harvested behind its spinner has nothing (or the wrong thing) on it.
 */
import type { Page } from '@playwright/test';

export const SPINNER_SELECTOR = [
  '[class*="spinner" i]', '[class*="loader" i]:not([class*="loaded" i])', '[class*="loading" i]:not([class*="loaded" i])', '[class*="preload" i]',
  '[aria-busy="true"]', '[role="progressbar"]', '.MuiCircularProgress-root', '.MuiSkeleton-root', '.ant-spin-spinning', '.ant-skeleton',
  'ngx-spinner', '.blockUI', '.lds-ring', '.lds-dual-ring', '.sk-circle', '.skeleton', '#nprogress .bar',
].join(',');

/** true while a spinner / loader / skeleton is visible */
export async function spinnerVisible(page: Page): Promise<boolean> {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].some((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }), SPINNER_SELECTOR).catch(() => false);
}

export async function waitForSpinners(page: Page, maxMs = 20000): Promise<void> {
  for (const end = Date.now() + maxMs; Date.now() < end;) {
    if (!(await spinnerVisible(page))) return;
    await page.waitForTimeout(250);
  }
}

/** content stops changing: address, number of elements, main heading, text length — 3 checks in a row */
export async function waitStable(page: Page, maxMs = 8000): Promise<void> {
  const sig = () => page.evaluate(() => `${location.href}|${document.querySelectorAll('*').length}|${document.querySelector('h1')?.textContent?.trim() ?? ''}|${document.body?.innerText.length ?? 0}`).catch(() => '');
  let last = await sig(), same = 0;
  for (const end = Date.now() + maxMs; Date.now() < end && same < 3;) {
    await page.waitForTimeout(250);
    const now = await sig();
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

export async function settlePage(page: Page, opts: { idle?: number; spinner?: number } = {}): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: opts.idle ?? 6000 }).catch(() => {});
  await waitForSpinners(page, opts.spinner ?? 20000);
  await waitStable(page);
  await waitForSpinners(page, 5000); // some apps show a second loader once the first data arrives
}
