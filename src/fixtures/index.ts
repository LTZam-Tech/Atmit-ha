/**
 * Fixtures — the framework's dependency injection. Tests ask for what they need:
 *   test('...', async ({ ui, data, api }) => { ... })
 * App-specific Page Objects are added in apps/<app>/fixtures.ts (see apps/demo).
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { DataFactory } from '../data';
import { seededFaker } from '../data/faker';
import { ApiClient } from '../utils/api-client';
import { environment } from '../../config/environment';
import { authFile, pageForTags } from '../core/pages-setup';
import { SmartOR } from '../core/or/resolver';
import { openPage, waitReady } from '../pages/base.page';
import { loadRepository } from '../core/or/loader';
import { findRoute, readNavigation } from '../core/navigation';
import { runSteps } from '../core/cases/runner';
import { step } from '../utils/steps';
import { fakerEN } from '@faker-js/faker';
import { keyFromUrl, saveDraft } from '../core/drafts';
import { watcherScript, type SeenMessage } from '../core/harvest';
import { sameAddress } from '../utils/url';

export { authFile };

/** Untyped access to any OR page — used by no-code cases and quick scripts */
export class UI {
  private cache = new Map<string, SmartOR>();
  constructor(readonly page: Page) {}
  or(pageKey: string): SmartOR {
    if (!this.cache.has(pageKey)) this.cache.set(pageKey, new SmartOR(this.page, pageKey));
    return this.cache.get(pageKey)!;
  }
  /** waits until a page's "ready when" element is visible (after navigating some other way) */
  async ready(pageKey: string) {
    await waitReady(this.or(pageKey));
  }
  /** Opens a page by URL, or — for pages with `open: navigate` — by replaying the shortest route of the navigation map */
  async open(pageKey: string, query = '') {
    const target = this.or(pageKey);
    const repo = loadRepository();
    const { edges } = readNavigation(undefined, repo);
    const route = findRoute(pageKey, edges, repo);
    if (target.def.open !== 'navigate') {
      try { return await openPage(this.page, target, query); }
      catch (e) {
        // self-healing: the address does not show the page, but the navigation map reaches it → go that way, and say so
        if (!route || route.start === pageKey) throw e;
        test.info().annotations.push({ type: 'or-healed', description: `${pageKey}: its address did not show the page — reached it through ${[route.start, ...route.edges.map((x) => x.to)].join(' → ')} instead. Fix it in Pages → 🩺 Check pages.` });
      }
    }
    if (!route) throw new Error(`Page "${pageKey}" opens through navigation, but no route reaches it. Add one in Control Panel → Pages → Map (or record a journey).`);
    await step.navigate(`Reach ${pageKey} via ${[route.start, ...route.edges.map((e) => e.to)].join(' → ')}`, async () => {
      await openPage(this.page, this.or(route.start));
      for (const e of route.edges) await runSteps(this, this.page, e.steps, { data: {}, faker: fakerEN, vars: {} });
      await waitReady(target);
    });
  }
}

interface Fixtures {
  ui: UI;
  data: DataFactory;
  api: ApiClient;
  runContext: void;
  lastPage: void;
  discover: Discovery;
}

/**
 * What a test run meets on the way: every page it reaches (redirects included) and every message that pops up
 * (toasts, alert boxes, dialogs — also the ones that disappear). Saved in the report, offered after the run as
 * new pages, messages and test cases to add. DISCOVER=0 turns it off.
 */
export class Discovery {
  visits: { url: string; by?: string }[] = [];
  messages: (SeenMessage & { url: string; by?: string })[] = [];
  async watch(context: BrowserContext, who?: string) {
    if (process.env.DISCOVER === '0') return;
    await context.exposeBinding('__atimthaReport', ({ page }, m: SeenMessage) => {
      if (this.messages.length < 40) this.messages.push({ ...m, url: page.url(), by: who });
    }).catch(() => {});
    await context.addInitScript({ content: watcherScript(environment.testIdAttribute, true) }).catch(() => {});
    const track = (page: Page) => page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      const url = f.url();
      if (/^https?:/.test(url) && this.visits.at(-1)?.url !== url && this.visits.length < 60) this.visits.push({ url, by: who });
    });
    context.pages().forEach(track);
    context.on('page', track);
  }
  toJSON() {
    const seen = new Set<string>();
    const visits = this.visits.filter((v) => { const k = v.url.split('#')[0]; return !seen.has(k) && seen.add(k); }).map((v) => ({ ...v, page: knownPageAt(v.url) ?? null }));
    const mseen = new Set<string>();
    const messages = this.messages.filter((m) => { const k = `${m.kind}|${m.text}|${m.css}`; return !mseen.has(k) && mseen.add(k); }).map((m) => ({ ...m, page: knownPageAt(m.url) ?? null }));
    return { visits, messages };
  }
}

/** OR page whose URL matches where the browser is now (undefined = a page not in the OR yet) */
function knownPageAt(url: string): string | undefined {
  try {
    const here = new URL(url);
    for (const p of loadRepository().values()) {
      if (!p.url) continue;
      if (sameAddress(p.url, url)) return p.page;
    }
  } catch { /* about:blank etc. */ }
  return undefined;
}

export const test = base.extend<Fixtures>({
  // Page start setup: a test tagged @<page> starts with the session that page declares (auth: ...)
  // in apps/<app>/or/<page>.page.yml. An explicit test.use({ storageState }) still wins.
  storageState: async ({ storageState }, use, testInfo) => {
    if (storageState) return use(storageState);
    const as = testInfo.tags.find((t) => t.startsWith('@as-'))?.slice(4);
    if (as) {
      testInfo.annotations.push({ type: 'start-session', description: as === 'none' ? 'logged out (case setting)' : `${as} (case setting)` });
      return use(as === 'none' ? undefined : authFile(as));
    }
    const page = pageForTags(testInfo.tags);
    if (page?.auth && page.auth !== 'none') {
      testInfo.annotations.push({ type: 'start-session', description: `${page.auth} (from or/${page.file})` });
      return use(authFile(page.auth));
    }
    await use(undefined);
  },

  ui: async ({ page }, use) => use(new UI(page)),

  data: async ({}, use, testInfo) => {
    const { faker, seed } = seededFaker(testInfo);
    testInfo.annotations.push({ type: 'data-seed', description: `${seed} (run SEED=${environment.seed})` });
    await use(new DataFactory(faker, seed));
  },

  api: async ({ request }, use) => use(new ApiClient(request)),

  // Auto fixture: where did the test end? → "last-page" in the report. A page that is not in the OR
  // is offered as "Detect & continue". With DETECT_LAST=<pageKey> the page is harvested as a draft.
  lastPage: [
    async ({ page }, use, testInfo) => {
      await use();
      if (page.isClosed()) return;
      const url = page.url();
      if (!/^https?:/.test(url)) return;
      const title = await page.title().catch(() => '');
      const known = knownPageAt(url);
      testInfo.annotations.push({ type: 'last-page', description: JSON.stringify({ url, title, page: known ?? null }) });
      const detect = process.env.DETECT_LAST;
      if (detect) {
        const start = pageForTags(testInfo.tags);
        const n = await saveDraft(page, {
          app: environment.app, key: detect === '1' ? keyFromUrl(url) : detect, testIdAttribute: environment.testIdAttribute,
          auth: start?.auth && start.auth !== 'none' ? start.auth : undefined,
          description: `DRAFT — reached at the end of "${testInfo.title}" on ${new Date().toISOString().slice(0, 10)}`,
        });
        testInfo.annotations.push({ type: 'detected', description: `${n} element(s) → or/drafts/${detect === '1' ? keyFromUrl(url) : detect}.page.yml` });
      }
    },
    { auto: true },
  ],

  // Auto fixture: pages reached and messages that popped up during the test → "discoveries" in the report
  discover: [
    async ({ context }, use, testInfo) => {
      const d = new Discovery();
      await d.watch(context);
      await use(d);
      const j = d.toJSON();
      if (j.visits.length || j.messages.length) testInfo.annotations.push({ type: 'discoveries', description: JSON.stringify(j) });
    },
    { auto: true },
  ],

  // Auto fixture: stamps run context on every test for the Smart Report
  runContext: [
    async ({}, use, testInfo) => {
      testInfo.annotations.push({ type: 'context', description: `app=${environment.app}; env=${environment.name}; locale=${environment.locale}` });
      await use();
    },
    { auto: true },
  ],
});

export { expect };
