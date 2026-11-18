/**
 * 🩺 Check pages — open every page of the Smart OR by its address (with the session it starts with) and tell
 * whether it becomes ready. Catches pages collected while the previous page was still on screen (page
 * transitions, slow single-page apps), addresses that redirect, and "ready when" elements that changed.
 */
import fs from 'node:fs';
import { chromium, selectors, type BrowserContext } from '@playwright/test';
import { loadApp, orDir } from './app';
import { readRepository } from './or/loader';
import { SmartOR } from './or/resolver';
import { authFile } from './pages-setup';
import { withBaseQuery } from '../utils/url';
import { settlePage } from '../utils/settle';

export interface PageCheck { page: string; url: string; ok: boolean | null; reached?: string; reason?: string; found?: number; total?: number; fix?: string }

export async function checkPages(app: string, envName?: string): Promise<PageCheck[]> {
  const cfg = loadApp(app);
  const name = envName && cfg.environments[envName] ? envName : cfg.defaultEnv || Object.keys(cfg.environments)[0];
  const env = cfg.environments[name];
  const repo = readRepository(orDir(app));
  selectors.setTestIdAttribute(cfg.testIdAttribute);
  const browser = await chromium.launch();
  const contexts = new Map<string, BrowserContext>();
  const ctxFor = async (auth: string) => {
    if (!contexts.has(auth)) {
      const state = auth !== 'none' && fs.existsSync(authFile(auth, app)) ? authFile(auth, app) : undefined;
      contexts.set(auth, await browser.newContext({ baseURL: env.baseURL, ignoreHTTPSErrors: env.ignoreHTTPSErrors, httpCredentials: env.httpCredentials, storageState: state }));
    }
    return contexts.get(auth)!;
  };
  const out: PageCheck[] = [];
  try {
    for (const def of repo.values()) {
      const url = def.url ?? '/';
      if (def.open === 'navigate') { out.push({ page: def.page, url, ok: null, reason: 'Opens through the navigation map, not by its address' }); continue; }
      const auth = def.auth && def.auth !== 'none' ? def.auth : 'none';
      const page = await (await ctxFor(auth)).newPage();
      try {
        await page.goto(withBaseQuery(url, env.baseURL), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settlePage(page, { idle: 5000 });
        const or = new SmartOR(page, def.page, { dir: orDir(app) });
        const shows = async (n: string, t: number) => { const l = await or.el(n, {}, { timeout: t }).catch(() => undefined); return !!l && (await l.first().isVisible().catch(() => false)); };
        const reached = new URL(page.url()).pathname;
        const names = Object.keys(def.elements).filter((n) => !['alert', 'dialog'].includes(String(def.elements[n].control)) && !/Close$/.test(n) && !Object.keys(def.elements[n]).includes('params'));
        if (def.readyWhen && (await shows(def.readyWhen, 6000))) { out.push({ page: def.page, url, ok: true }); continue; }
        // not ready → how much of the page is there?
        // headings and fields say more about a page than menu links shared by every page
        const rank = (n: string) => { const d = def.elements[n] as { control?: string; role?: string; href?: string }; return d.control === 'heading' || d.role === 'heading' ? 0 : ['textbox', 'textarea', 'select', 'button', 'datepicker'].includes(String(d.control)) ? 1 : d.control === 'link' || d.href ? 3 : 2; };
        const sample = [...names].sort((a, b) => rank(a) - rank(b)).slice(0, 12);
        const visible: string[] = [];
        for (const n of sample) if (await shows(n, 600)) visible.push(n);
        const moved = reached.replace(/\/$/, '') !== new URL(url, env.baseURL).pathname.replace(/\/$/, '');
        const reason = moved ? `The address redirects to ${reached}${auth === 'none' ? '' : ` (session: ${auth})`} — the page may need a login, or opens only after a click`
          : !def.readyWhen ? 'No "ready when" element is set'
          : visible.length / Math.max(1, sample.length) < 0.4 ? `Most of its elements are not on this page (${visible.length}/${sample.length}) — it was probably collected while the previous page was still showing. Collect it again.`
          : `"${def.readyWhen}" is not on the page, but other elements are — use one of them as "ready when"`;
        out.push({ page: def.page, url, ok: false, reached, reason, found: visible.length, total: sample.length, fix: !moved && visible.length / Math.max(1, sample.length) >= 0.4 ? visible[0] : undefined });
      } catch (e) {
        out.push({ page: def.page, url, ok: false, reason: `Could not open it: ${(e as Error).message.split('\n')[0]}` });
      } finally { await page.close().catch(() => {}); }
    }
  } finally { await browser.close().catch(() => {}); }
  return out;
}
