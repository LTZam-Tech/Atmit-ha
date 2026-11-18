/**
 * Check one OR element on the live page (Control Panel → Pages → elements → Check).
 *   APP=<app> tsx scripts/check-element.ts <page> <element> [params-json]
 * Opens the page in its start state, resolves the element with the Smart OR and prints
 *   @@RESULT { found, count, strategy, healed, visible, screenshot }
 */
import { chromium, selectors } from '@playwright/test';
import { environment } from '../config/environment';
import { SmartOR } from '../src/core/or/resolver';
import { ensureApp, ensureSession } from '../src/utils/app-server';

const [pageKey, element, paramsJson] = process.argv.slice(2);
const params = paramsJson ? JSON.parse(paramsJson) : {};
const done = (r: unknown) => console.log('@@RESULT ' + JSON.stringify(r));

(async () => {
  const app = await ensureApp();
  selectors.setTestIdAttribute(environment.testIdAttribute);
  const browser = await chromium.launch();
  try {
    const probe = new SmartOR(await (await browser.newContext()).newPage(), pageKey); // read def only
    const storageState = await ensureSession(probe.def.auth);
    const context = await browser.newContext({
      baseURL: environment.baseURL, storageState, viewport: { width: 1280, height: 800 },
      locale: environment.locale === 'ar' ? 'ar-JO' : 'en-US',
      ignoreHTTPSErrors: environment.ignoreHTTPSErrors, httpCredentials: environment.httpCredentials,
    });
    const page = await context.newPage();
    await page.goto(probe.def.url ?? '/');
    const or = new SmartOR(page, pageKey);
    const primaryCount = await or.locator(element, params).count();
    let result: Record<string, unknown> = { primaryCount };
    try {
      const loc = await or.el(element, params);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.evaluate((n: HTMLElement) => { n.style.outline = '3px solid #e34948'; n.style.outlineOffset = '2px'; }).catch(() => {});
      result = { ...result, found: true, visible: await loc.isVisible(), healed: primaryCount !== 1 };
    } catch (e) {
      result = { ...result, found: false, error: (e as Error).message.replace(/^\[Smart OR\]\s*/, '') };
    }
    result.screenshot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    done({ ok: true, ...result });
  } finally {
    await browser.close();
    app?.kill();
  }
})().catch((e) => { done({ ok: false, error: String(e.message ?? e) }); process.exitCode = 1; });
