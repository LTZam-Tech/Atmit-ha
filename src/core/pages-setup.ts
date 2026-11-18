/**
 * Page start setup — read from each apps/<app>/or/*.page.yml:
 *   auth: standard | none     → which saved session a test starts with
 *   tags: ['@inventory']      → which tests belong to the page (default @<page>)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, appDir, currentApp } from './app';
import { loadRepository } from './or/loader';
import type { NormalizedPageDef } from './or/types';

export const authDir = (app = currentApp()) => path.join(ROOT, '.auth', app);
export const authFile = (user: string, app = currentApp()) => path.join(authDir(app), `${user}.json`);

export const tagsOf = (p: NormalizedPageDef) => (p.tags?.length ? p.tags : [`@${p.page}`]);

/** First page whose tag is on the test */
export function pageForTags(tags: string[], repo = loadRepository()): NormalizedPageDef | undefined {
  for (const page of repo.values()) {
    if (tagsOf(page).some((t) => tags.includes(t))) return page;
  }
  return undefined;
}

/** Every user that some page, case (user:) or workflow (as:) needs a session for */
export function requiredSessions(repo = loadRepository(), app = currentApp()): string[] {
  const users = new Set<string>();
  for (const page of repo.values()) if (page.auth && page.auth !== 'none') users.add(page.auth);
  for (const [dir, re] of [['cases', /^user:\s*["']?([\w-]+)/gm], ['flows', /\bas:\s*["']?([\w-]+)/g]] as const) {
    const d = path.join(appDir(app), dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.yml'))) {
      for (const m of fs.readFileSync(path.join(d, f), 'utf8').matchAll(re)) if (m[1] !== 'none') users.add(m[1]);
    }
  }
  return [...users];
}
