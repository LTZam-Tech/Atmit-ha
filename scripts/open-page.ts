/**
 * Open a page from the Smart OR in a real browser, already in the start state the page
 * declares (auth session, language), with the Playwright Inspector to pick locators.
 *
 *   npm run page:open -- inventory
 *   ENV=uat LOCALE=ar npm run page:open -- patients
 */
import type { ChildProcess } from 'node:child_process';
import { chromium, selectors } from '@playwright/test';
import { environment } from '../config/environment';
import { loadRepository } from '../src/core/or/loader';
import { ensureApp, ensureSession } from '../src/utils/app-server';

const key = process.argv.slice(2).find((a) => !a.startsWith('--'));
const pages = loadRepository();
if (!key || !pages.has(key)) {
  console.error(`Usage: npm run page:open -- <page>\nPages: ${[...pages.keys()].join(', ')}`);
  process.exit(1);
}
const def = pages.get(key)!;
let demo: ChildProcess | undefined;

(async () => {
  demo = await ensureApp();

  // Start state the page declares: session (setup runs once if missing)
  const storageState = await ensureSession(def.auth);

  selectors.setTestIdAttribute(environment.testIdAttribute);
  const browser = await chromium.launch({ headless: false, channel: process.env.BROWSER_CHANNEL || undefined });
  const context = await browser.newContext({
    baseURL: environment.baseURL,
    storageState,
    locale: environment.locale === 'ar' ? 'ar-JO' : 'en-US',
    ignoreHTTPSErrors: environment.ignoreHTTPSErrors,
    httpCredentials: environment.httpCredentials,
    viewport: null,
  });
  const page = await context.newPage();
  await page.goto(def.url ?? '/');
  console.log(`✔ ${key} opened at ${page.url()} (auth: ${def.auth ?? 'none'}, locale: ${environment.locale})`);
  console.log('  Use the Inspector "Pick locator" button to get locators. Close the browser to finish.');
  page.on('close', () => browser.close());
  await page.pause();
  await new Promise((r) => browser.on('disconnected', r));
})()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => demo?.kill());
