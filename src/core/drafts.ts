/** Writes a harvested page as a draft OR file (apps/<app>/or/drafts/<key>.page.yml) + its visual map */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Page } from '@playwright/test';
import { orDir } from './app';
import { harvestPage, pickReadyElement } from './harvest';
import { pageSize, saveVisual } from './visual';
import { pagePath } from '../utils/url';

export async function saveDraft(page: Page, opts: { app: string; key: string; testIdAttribute: string; auth?: string; description: string }) {
  const items = await harvestPage(page, opts.testIdAttribute);
  const doc = {
    page: opts.key,
    url: pagePath(page.url()),
    description: opts.description,
    ...(opts.auth ? { auth: opts.auth } : {}),
    readyWhen: pickReadyElement(items),
    settings: { timeout: 10000 },
    elements: Object.fromEntries(items.map((i) => [i.name, i.def])),
  };
  const outDir = path.join(orDir(opts.app), 'drafts');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${opts.key}.page.yml`), `# yaml-language-server: $schema=../../../../src/core/or/or.schema.json\n` + YAML.stringify(doc, { lineWidth: 0 }));
  saveVisual(outDir, `${opts.key}.visual`, await page.screenshot({ fullPage: true }), {
    url: page.url(), ...(await pageSize(page)), captured: new Date().toISOString(),
    boxes: Object.fromEntries(items.map((i) => [i.name, i.meta.box.w || i.meta.box.h ? i.meta.box : null])),
  });
  return items.length;
}

/** page key suggestion from a URL: /patients/new.html → patientsNew */
export function keyFromUrl(url: string): string {
  const parts = new URL(url).pathname.replace(/\.(html?|aspx?|php|jsp)$/i, '').split(/[\/_.-]+/).filter((p) => p && !/^\d+$/.test(p));
  const k = parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p.toLowerCase())).join('') || 'home';
  return /^[a-z]/.test(k) ? k.replace(/[^\w]/g, '') : 'page' + k;
}
