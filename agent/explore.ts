/**
 * "Explore" jobs (backlog §3/§6): the agent opens each address headless — signed in as a test user when the job says
 * so — and collects the page's elements with the same harvester as the local panel (src/core/harvest.ts). The result
 * is draft pages, exactly as saveDraft writes them, uploaded as the run file explore.json; people review each draft
 * and send it to the review queue from the run page. Nothing is written to the project here.
 */
import fs from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { harvestPage, pickReadyElement } from '../src/core/harvest';
import { keyFromUrl } from '../src/core/drafts';
import { pagePath } from '../src/utils/url';

export interface ExploreInput { urls: string[]; as?: string | null }
export interface ExploredPage { key: string; url: string; title: string; elements: number; content: Record<string, unknown> }
export interface ExploreResult { pages: ExploredPage[]; errors: { url: string; error: string }[]; signedInAs: string | null }

/** an address on the environment's own host (the platform checks this too); anything else is refused */
export function resolveOnHost(url: string, baseURL: string): string {
  const base = new URL(baseURL);
  const u = new URL(url, base);
  if (u.origin !== base.origin) throw new Error(`${url} is not on ${base.origin}`);
  return u.toString();
}

export async function explore(opts: {
  input: ExploreInput; baseURL: string; testIdAttribute: string; storageState?: string; ignoreHTTPSErrors?: boolean;
  locale?: 'en' | 'ar'; stopped?: () => boolean; log?: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<ExploreResult> {
  const out: ExploreResult = { pages: [], errors: [], signedInAs: opts.input.as ?? null };
  const used = new Set<string>();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: opts.baseURL,
      ignoreHTTPSErrors: opts.ignoreHTTPSErrors,
      locale: opts.locale === 'ar' ? 'ar-JO' : 'en-US',
      storageState: opts.storageState && fs.existsSync(opts.storageState) ? opts.storageState : undefined,
    });
    const page = await context.newPage();
    for (const raw of opts.input.urls.slice(0, 20)) {
      if (opts.stopped?.()) break;
      try {
        const url = resolveOnHost(raw, opts.baseURL);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => { /* busy pages: collect what is there */ });
        const items = await harvestPage(page, opts.testIdAttribute);
        let key = keyFromUrl(page.url());
        for (let n = 2; used.has(key); n++) key = `${keyFromUrl(page.url())}${n}`;
        used.add(key);
        const path = pagePath(page.url());
        out.pages.push({
          key, url: path, title: await page.title(), elements: items.length,
          content: {
            page: key,
            url: path,
            description: `Collected by Explore from ${path}`,
            ...(opts.input.as ? { auth: opts.input.as } : {}),
            readyWhen: pickReadyElement(items),
            settings: { timeout: 10000 },
            elements: Object.fromEntries(items.map((i) => [i.name, i.def])),
          },
        });
        opts.log?.('page collected', { url: path, key, elements: items.length });
      } catch (e) {
        out.errors.push({ url: raw, error: (e as Error).message.split('\n')[0].slice(0, 500) });
      }
    }
  } finally {
    await browser?.close();
  }
  return out;
}
