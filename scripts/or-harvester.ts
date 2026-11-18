/**
 * OR Harvester — opens a page and writes a DRAFT Smart OR file with the best unique locator
 * per element as primary and the next ones as fallbacks.
 *
 *   npm run or:harvest -- <url|path> <pageKey> [--auth standard] [--lang ar] [--headed]
 *   (--auth: start logged in as that user — needed for pages behind login)
 *
 * Output: apps/<app>/or/drafts/<pageKey>.page.yml → review, then promote (Control Panel → Pages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, selectors } from '@playwright/test';
import YAML from 'yaml';
import { environment } from '../config/environment';
import { orDir } from '../src/core/app';
import { harvestPage, pickReadyElement } from '../src/core/harvest';
import { pageSize, saveVisual } from '../src/core/visual';
import { ensureApp, ensureSession } from '../src/utils/app-server';
import { pagePath, withBaseQuery } from '../src/utils/url';
import { settlePage } from '../src/utils/settle';

const flag = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const auth = opt('auth');
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--auth', '--lang'].includes(all[i - 1]));
const [target, pageKey] = args;
if (!target || !pageKey) {
  console.error('Usage: npm run or:harvest -- <url|path> <pageKey> [--auth <user>] [--lang ar] [--headed]');
  process.exit(1);
}
const url = /^https?:/.test(target) ? target : withBaseQuery(new URL(target, environment.baseURL).toString(), environment.baseURL);

(async () => {
  const app = await ensureApp();
  selectors.setTestIdAttribute(environment.testIdAttribute);
  const browser = await chromium.launch({ headless: !flag('headed') });
  const storageState = await ensureSession(auth);
  const page = await browser.newPage({
    locale: opt('lang') === 'ar' ? 'ar-JO' : 'en-US', storageState,
    ignoreHTTPSErrors: environment.ignoreHTTPSErrors, httpCredentials: environment.httpCredentials,
  });
  console.log(`→ Harvesting ${url}${auth ? ` as ${auth}` : ''}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => page.waitForLoadState('load'));
  await settlePage(page); // spinners, late rendering
  if (new URL(page.url()).pathname !== new URL(url).pathname) {
    console.warn(`⚠ Redirected to ${page.url()} — the page may need a session. Use --auth <user>.`);
  }
  const items = await harvestPage(page, environment.testIdAttribute);
  const doc = {
    page: pageKey,
    url: pagePath(url),
    description: `DRAFT harvested from ${url} on ${new Date().toISOString().slice(0, 10)} — review names before use`,
    ...(auth ? { auth } : {}),
    readyWhen: pickReadyElement(items),
    settings: { timeout: 10000 },
    elements: Object.fromEntries(items.map((i) => [i.name, i.def])),
  };
  const outDir = path.join(orDir(environment.app), 'drafts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${pageKey}.page.yml`);
  fs.writeFileSync(outFile, `# yaml-language-server: $schema=../../../../src/core/or/or.schema.json\n` + YAML.stringify(doc, { lineWidth: 0 }));
  saveVisual(outDir, `${pageKey}.visual`, await page.screenshot({ fullPage: true }), {
    url: page.url(), ...(await pageSize(page)), captured: new Date().toISOString(),
    boxes: Object.fromEntries(items.map((i) => [i.name, i.meta.box.w || i.meta.box.h ? i.meta.box : null])),
  });
  const classified = items.filter((i) => i.def.semantic).length;
  console.log(`✔ ${items.length} element(s) → ${path.relative(process.cwd(), outFile)} (${classified} with a detected meaning)`);
  await browser.close();
  app?.kill();
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
