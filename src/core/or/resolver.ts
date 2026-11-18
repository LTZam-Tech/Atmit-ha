/**
 * Smart OR resolver — turns a YAML element definition into a Playwright Locator.
 *
 *   locator(name)  → primary strategy only, lazy, no fallback.
 *                    Use it for NEGATIVE checks ("is NOT visible") so a fallback can never
 *                    find a different element and hide a real bug.
 *   el(name)       → waits for the element, tries primary then fallbacks, requires a UNIQUE
 *                    match, and records any healing in the report.
 */
import { test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { environment, runConfig, type Locale } from '../../../config/environment';
import { loadRepository } from './loader';
import type { ElementDef, LocalizedText, NormalizedPageDef, StrategyDef } from './types';

type Root = Page | Locator | FrameLocator;
export type Params = Record<string, string | number>;

export class ORError extends Error {
  constructor(message: string) {
    super(`[Smart OR] ${message}`);
    this.name = 'ORError';
  }
}

export class SmartOR {
  readonly def: NormalizedPageDef;
  private readonly timeout: number;

  private readonly locale: Locale;

  /** opts.dir → read another app's OR (Control Panel / wizard); default is the current app */
  constructor(readonly page: Page, pageKey: string, opts: { locale?: Locale; dir?: string } = {}) {
    this.locale = opts.locale ?? environment.locale;
    const def = loadRepository(opts.dir).get(pageKey);
    if (!def) throw new ORError(`Page "${pageKey}" not found in apps/<app>/or/*.page.yml`);
    this.def = def;
    this.timeout = Math.max(def.settings?.timeout ?? 0, runConfig.waitTimeout); // a slow site raises every page's wait
  }

  /** Primary strategy only (no fallback, no waiting). */
  locator(name: string, params: Params = {}): Locator {
    const def = this.element(name);
    return this.build(def, this.rootFor(def, params, (n, p) => this.locator(n, p)), params, def);
  }

  /** Smart resolution with fallback + uniqueness check + healing report. */
  async el(name: string, params: Params = {}, opts: { timeout?: number } = {}): Promise<Locator> {
    const def = this.element(name);
    const timeout = opts.timeout ?? this.timeout;
    const root = def.within ? await this.el(def.within, params, opts) : this.rootFor(def, params);
    const strategies: StrategyDef[] = [def, ...(this.fallbackEnabled ? def.fallback ?? [] : [])];
    const candidates = strategies.map((s) => this.build(s, root, params, def));

    // 1) wait until ANY candidate appears
    const any = candidates.reduce((a, b) => a.or(b));
    try {
      await any.first().waitFor({ state: 'attached', timeout });
    } catch {
      throw new ORError(
        `Element "${this.def.page}.${name}" not found within ${timeout}ms.\n` +
          `  Tried: ${strategies.map(describe).join('  →  ')}\n  OR file: or/${this.def.file}`,
      );
    }

    // 2) give the primary a short grace period — avoid healing to a fallback during page load
    if ((await candidates[0].count()) === 0 && candidates.length > 1) {
      await candidates[0].first().waitFor({ state: 'attached', timeout: 400 }).catch(() => {});
    }

    // groups (radio / checkbox sets) legitimately match several inputs
    if (def.control === 'radiogroup' || def.control === 'checkgroup') {
      for (const c of candidates) if ((await c.count()) > 0) return c;
    }

    // 3) first candidate that matches exactly ONE element wins
    const counts: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const n = await candidates[i].count();
      counts.push(n);
      if (n === 1) {
        if (i > 0) this.annotate('or-healed', `${this.def.page}.${name}: primary [${describe(def)}] failed → used fallback #${i} [${describe(strategies[i])}]. Update or/${this.def.file}`);
        if ('xpath' in strategies[i]) this.annotate('or-xpath', `${this.def.page}.${name} resolved by XPath — fragile, prefer testid/role`);
        return candidates[i];
      }
    }
    throw new ORError(
      `Element "${this.def.page}.${name}" is ambiguous — no strategy matched exactly one element.\n` +
        `  Matches: ${strategies.map((s, i) => `${describe(s)} = ${counts[i]}`).join(', ')}\n` +
        `  Fix: add "nth", "hasText" or "within" in or/${this.def.file}`,
    );
  }

  has(name: string): boolean {
    return name in this.def.elements;
  }

  // ---------------------------------------------------------------- internals

  private get fallbackEnabled() {
    return this.def.settings?.fallback !== false;
  }

  private element(name: string): ElementDef {
    const def = this.def.elements[name];
    if (!def) {
      const known = Object.keys(this.def.elements).join(', ');
      throw new ORError(`Element "${name}" not defined on page "${this.def.page}". Known: ${known}`);
    }
    return def;
  }

  private rootFor(def: ElementDef, params: Params, parentResolver?: (n: string, p: Params) => Locator): Root {
    if (def.within && parentResolver) return parentResolver(def.within, params);
    if (def.frame) return this.page.frameLocator(def.frame);
    return this.page;
  }

  private build(s: StrategyDef, root: Root, params: Params, owner: ElementDef): Locator {
    const txt = (v: LocalizedText) => fill(this.localize(v), params);
    let loc: Locator;
    if (s.testid !== undefined) loc = root.getByTestId(fill(s.testid, params));
    else if (s.role !== undefined)
      loc = root.getByRole(s.role as Parameters<Page['getByRole']>[0], {
        ...(s.name !== undefined ? { name: txt(s.name) } : {}),
        ...(s.exact !== undefined ? { exact: s.exact } : {}),
      });
    else if (s.label !== undefined) loc = root.getByLabel(txt(s.label), { exact: s.exact });
    else if (s.placeholder !== undefined) loc = root.getByPlaceholder(txt(s.placeholder), { exact: s.exact });
    else if (s.text !== undefined) loc = root.getByText(txt(s.text), { exact: s.exact });
    else if (s.alt !== undefined) loc = root.getByAltText(txt(s.alt), { exact: s.exact });
    else if (s.title !== undefined) loc = root.getByTitle(txt(s.title), { exact: s.exact });
    else if (s.id !== undefined) loc = root.locator(`[id="${fill(s.id, params)}"]`);
    else if (s.css !== undefined) loc = root.locator(fill(s.css, params));
    else if (s.xpath !== undefined) loc = root.locator(`xpath=${fill(s.xpath, params)}`);
    else throw new ORError(`No strategy in ${JSON.stringify(s)}`);

    if (owner.hasText !== undefined) loc = loc.filter({ hasText: txt(owner.hasText) });
    if (owner.nth !== undefined) loc = loc.nth(owner.nth);
    return loc;
  }

  private localize(v: LocalizedText): string {
    if (typeof v === 'string') return v;
    return v[this.locale] ?? v.en;
  }

  private annotate(type: string, description: string) {
    try {
      const info = test.info();
      if (!info.annotations.some((a) => a.type === type && a.description === description)) {
        info.annotations.push({ type, description });
      }
    } catch {
      /* called outside a test (e.g. harvester) */
    }
  }
}

function fill(value: string, params: Params): string {
  return value.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in params)) throw new ORError(`Missing parameter "{${key}}" — pass it as el('name', { ${key}: ... })`);
    return String(params[key]);
  });
}

function describe(s: StrategyDef): string {
  const key = (['testid', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'id', 'css', 'xpath'] as const).find((k) => k in s)!;
  const val = s[key] as LocalizedText;
  const shown = typeof val === 'string' ? val : val.en;
  const name = s.role && s.name ? ` name="${typeof s.name === 'string' ? s.name : s.name.en}"` : '';
  return `${key}=${shown}${name}`;
}
