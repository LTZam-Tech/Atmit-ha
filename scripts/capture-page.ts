/**
 * Refresh the visual map of OR pages (screenshot + element boxes).
 *   APP=<app> tsx scripts/capture-page.ts <page> [<page> …]     (no page = all pages)
 */
import { chromium, selectors } from '@playwright/test';
import { environment } from '../config/environment';
import { loadRepository, paramsOf, OR_DIR } from '../src/core/or/loader';
import { SmartOR } from '../src/core/or/resolver';
import { boxOf, pageSize, saveVisual, visualDir } from '../src/core/visual';
import { ensureApp, ensureSession } from '../src/utils/app-server';

const repo = loadRepository();

/** one box around all inputs (and their labels) of a radio / checkbox group */
async function groupBox(loc: import('@playwright/test').Locator) {
  return loc.evaluateAll((els) => {
    const rs = els.map((e) => (e.closest('label') ?? e).getBoundingClientRect());
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
    return { x: Math.round(x + scrollX), y: Math.round(y + scrollY), w: Math.round(Math.max(...rs.map((r) => r.right)) - x), h: Math.round(Math.max(...rs.map((r) => r.bottom)) - y) };
  });
}
const keys = process.argv.slice(2).length ? process.argv.slice(2) : [...repo.keys()];

(async () => {
  const app = await ensureApp();
  selectors.setTestIdAttribute(environment.testIdAttribute);
  const browser = await chromium.launch();
  try {
    for (const key of keys) {
      const def = repo.get(key);
      if (!def) { console.log(`✖ ${key}: not in the OR`); continue; }
      const context = await browser.newContext({
        baseURL: environment.baseURL, storageState: await ensureSession(def.auth), viewport: { width: 1280, height: 800 },
        locale: environment.locale === 'ar' ? 'ar-JO' : 'en-US',
        ignoreHTTPSErrors: environment.ignoreHTTPSErrors, httpCredentials: environment.httpCredentials,
      });
      const page = await context.newPage();
      await page.goto(def.url ?? '/');
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const or = new SmartOR(page, key);
      const boxes: Record<string, ReturnType<typeof Object> | null> = {};
      let found = 0;
      for (const name of Object.keys(def.elements)) {
        if (paramsOf(def, name).length) { boxes[name] = null; continue; }
        const loc = await or.el(name, {}, { timeout: 1500 }).catch(() => null);
        const grp = ['radiogroup', 'checkgroup'].includes(def.elements[name].control ?? '');
        boxes[name] = loc ? (grp ? await groupBox(loc) : await boxOf(loc)) : null;
        if (boxes[name]) found++;
      }
      const size = await pageSize(page);
      saveVisual(visualDir(OR_DIR), key, await page.screenshot({ fullPage: true }), {
        url: page.url(), ...size, captured: new Date().toISOString(), boxes: boxes as never,
      });
      console.log(`✔ ${key}: screenshot + ${found}/${Object.keys(def.elements).length} element box(es)`);
      await context.close();
    }
  } finally {
    await browser.close();
    app?.kill();
  }
})().catch((e) => { console.error('✖ ' + (e.message ?? e)); process.exit(1); });
