/**
 * 🧭 Explore — build the Smart OR, the navigation map and a workflow by walking through the application.
 *
 *   start(base URL) → scan the page (elements, kind, meaning) → new page? register it in the Smart OR
 *   → suggest next steps (log in · fill the form with valid data and submit · click a link / button)
 *   → do the step in the same browser session → scan again → record the route → suggest again …
 *   → save the journey: one small case per step + a workflow that chains them in one session.
 *
 * Runs inside the Control Panel process (one exploration at a time). Rule-based, no AI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { chromium, selectors, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { fakerEN } from '@faker-js/faker';
import { appDir, loadApp, orDir, casesDir } from './app';
import { readRepository } from './or/loader';
import { STRATEGY_KEYS, type ElementDef, type NormalizedPageDef } from './or/types';
import { SmartOR } from './or/resolver';
import { harvestPage, detectLoginFields, pickReadyElement, readyCandidates, itemSig, uniqueName, watchMessages, collectMessages, type Harvested, type SeenMessage } from './harvest';
import { saveMessages, messageChecks, type FoundMessage } from './messages';
export type { FoundMessage } from './messages';
import { pageSize, saveVisual } from './visual';
import { keyFromUrl } from './drafts';
import { authFile } from './pages-setup';
import { readRawNavigation, writeNavigation } from './navigation';
import { serializeStep, parseElementRef, type Step } from './cases/model';
import { smartFill } from './cases/fill';
import { writeFlow } from './cases/flows';
import { addDays, formatDate, hijri, isoDate } from '../utils/dates';
import { pagePath, sameAddress } from '../utils/url';
import { settlePage } from '../utils/settle';
import { Negative } from '../data/negative/values';

export interface Suggestion {
  id: string;
  kind: 'login' | 'form' | 'click' | 'probe' | 'pick';
  label: string;
  detail?: string;
  steps: Step[];
  row?: Record<string, string>;
  user?: string;
  goesTo?: string;
  element?: string;
  /** checks proving the step worked when it stays on the same page (e.g. a success message) */
  expect?: Step[];
}
export interface JourneyStep { from: string; to: string; label: string; kind: Suggestion['kind']; steps: Step[]; row?: Record<string, string>; userBefore?: string; url: string; expect?: Step[]; found?: FoundMessage[] }

export interface ExploreElement { name: string; inOR: boolean; control?: string; semantic?: string; label: string; options?: string[]; box: { x: number; y: number; w: number; h: number } | null; clickable: boolean }

const D = (i: Harvested) => i.def as unknown as ElementDef;
const SKIP = /log\s?out|sign\s?out|delete|remove|خروج|حذف/i;
const CLICKABLE = ['button', 'link', 'tab', 'checkbox', 'picker', 'option'];

// datagen.js is shared with the Control Panel (plain ESM, no browser APIs)
type DataGen = { stepsFromPage: (p: unknown) => { steps: Step[]; outcomes: { name: string; steps: Step[] }[]; row: Record<string, string> }; isInput: (c?: string) => boolean };
let datagen: DataGen | undefined;
// a file:// URL — on Windows a plain C:\… path is not a valid ESM import
const loadDatagen = async (): Promise<DataGen> => (datagen ??= (await import(pathToFileURL(path.join(import.meta.dirname, '../../panel/app/datagen.js')).href)) as DataGen);

export class Explorer {
  app = '';
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  user?: string;
  journey: JourneyStep[] = [];
  created = new Set<string>(); // pages registered by this exploration (can still be renamed)
  lastFound: FoundMessage[] = []; // messages that appeared after the last step
  current?: { key: string; isNew: boolean; url: string; title: string; shot: string; size: { width: number; height: number }; elements: ExploreElement[]; suggestions: Suggestion[]; names: Map<Harvested, string>; items: Harvested[] };
  busy = false;
  error?: string;

  get running() { return !!this.page && !this.page.isClosed(); }

  /** a workflow this exploration continues: the case that ended where we start (saved as the workflow's first step) */
  after?: { case: string; row?: string };

  async start(o: { app: string; env?: string; url?: string; user?: string; headed?: boolean; after?: { case: string; row?: string } }) {
    await this.stop();
    const cfg = loadApp(o.app);
    const envName = o.env && cfg.environments[o.env] ? o.env : cfg.defaultEnv || Object.keys(cfg.environments)[0];
    const env = cfg.environments[envName];
    if (!env) throw new Error(`Unknown environment "${envName}"`);
    this.app = o.app;
    this.journey = [];
    this.created.clear();
    selectors.setTestIdAttribute(cfg.testIdAttribute);
    this.after = o.after;
    let state = o.user && o.user !== 'none' && fs.existsSync(authFile(o.user, o.app)) ? authFile(o.user, o.app) : undefined;
    const canLogin = !!(o.user && o.user !== 'none' && cfg.login && cfg.users[o.user]?.password);
    if (o.user && o.user !== 'none' && !state && !canLogin) throw new Error(`No saved login for "${o.user}" yet — start logged out and use "Log in as ${o.user}", or run the tests once (it saves the session).`);
    this.browser = await chromium.launch({ headless: !o.headed });
    this.context = await this.browser.newContext({ baseURL: env.baseURL, ignoreHTTPSErrors: env.ignoreHTTPSErrors, httpCredentials: env.httpCredentials, storageState: state, viewport: { width: 1280, height: 800 } });
    this.page = await this.context.newPage();
    if (!state && canLogin) {
      // no saved session yet → log in with the project's login settings, and keep the session for later runs
      const L = cfg.login!;
      const lp = this.repo().get(L.page);
      await this.page.goto(lp?.url ?? env.baseURL, { waitUntil: 'domcontentloaded' });
      const or = new SmartOR(this.page, L.page, { dir: orDir(o.app) });
      await smartFill(await or.el(L.fields.username), cfg.users[o.user!].username);
      await smartFill(await or.el(L.fields.password), cfg.users[o.user!].password!);
      await (await or.el(L.fields.submit)).click();
      await this.settle();
      await this.context.storageState({ path: authFile(o.user!, o.app) }).catch(() => {});
      state = authFile(o.user!, o.app);
    }
    this.user = state ? o.user : undefined;
    // nothing typed → the environment address itself (with its path, e.g. https://site.com/app/login)
    await this.page.goto(o.url?.trim() ? o.url.trim() : env.baseURL, { waitUntil: 'domcontentloaded' });
    await this.settle();
    await this.scan();
  }

  async stop() {
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = undefined;
    this.current = undefined;
  }

  private async settle() {
    await settlePage(this.page!, { idle: 4000 });
  }

  private repo() { return readRepository(orDir(this.app)); }

  /** OR page at this URL (path match) */
  private known(url: string, repo: Map<string, NormalizedPageDef>): NormalizedPageDef | undefined {
    // most specific first: a page saved with ?venue=abc wins over the same path without it
    return [...repo.values()].filter((p) => p.url && sameAddress(p.url, url)).sort((a, b) => b.url!.length - a.url!.length)[0];
  }

  /** scan the current page: recognise or register it, list its elements, suggest next steps */
  async scan() {
    const page = this.page!;
    const cfg = loadApp(this.app);
    let repo = this.repo();
    const prev = this.current;
    const shared = new Set((prev?.items ?? []).map(itemSig));
    let items = await harvestPage(page, cfg.testIdAttribute, 80);
    let url = page.url();
    // the address changed but the content is still the previous page (page transitions, slow SPA) → wait and look again
    const samePath = (a: string, b: string) => { try { return new URL(a).pathname === new URL(b).pathname; } catch { return false; } };
    for (let tries = 0; prev && !samePath(prev.url, url) && tries < 4; tries++) {
      const overlap = items.length ? items.filter((i) => shared.has(itemSig(i))).length / items.length : 1;
      if (overlap < 0.85) break;
      await page.waitForTimeout(1200);
      await this.settle();
      items = await harvestPage(page, cfg.testIdAttribute, 80);
      url = page.url();
    }
    let def = this.known(url, repo);
    let isNew = false;
    if (!def) {
      // new page → register it in the Smart OR with everything detected
      let key = keyFromUrl(url);
      for (let i = 2; repo.has(key); i++) key = `${keyFromUrl(url)}${i}`;
      const doc = {
        page: key, url: pagePath(url),
        description: `Found while exploring on ${new Date().toISOString().slice(0, 10)}${this.journey.length ? ` — reached after "${this.journey.at(-1)!.label}"` : ''}`,
        ...(this.user ? { auth: this.user } : {}),
        readyWhen: pickReadyElement(items, shared),
        settings: { timeout: 10000 },
        elements: Object.fromEntries(items.map((i) => [i.name, i.def])),
      };
      fs.writeFileSync(path.join(orDir(this.app), `${key}.page.yml`), `# yaml-language-server: $schema=../../../src/core/or/or.schema.json\n` + YAML.stringify(doc, { lineWidth: 0 }));
      this.created.add(key);
      isNew = true;
      // tests open this page by its address → the "ready when" element must show when the address is opened directly
      await this.checkDirectOpen(key, url, readyCandidates(items, shared));
      repo = this.repo();
      def = repo.get(key)!;
    }
    // harvested element → its OR name (known pages: match the locator; otherwise added when used)
    const names = new Map<Harvested, string>();
    for (const it of items) { const n = matchElement(def, it); if (n) names.set(it, n); }
    const png = await page.screenshot({ fullPage: true });
    const size = await pageSize(page);
    saveVisual(path.join(orDir(this.app), '.visual'), def.page, png, {
      url, ...size, captured: new Date().toISOString(),
      boxes: Object.fromEntries(items.filter((i) => names.has(i)).map((i) => [names.get(i)!, i.meta.box.w || i.meta.box.h ? i.meta.box : null])),
    });
    const title = await page.title().catch(() => '');
    this.current = {
      key: def.page, isNew: isNew || this.created.has(def.page), url, title, shot: `data:image/png;base64,${png.toString('base64')}`, size, names,
      elements: items.map((i) => ({ name: names.get(i) ?? i.name, inOR: names.has(i), control: D(i).control, semantic: D(i).semantic, label: String(i.meta.name || i.name), options: D(i).control === 'picker' || D(i).control === 'select' || D(i).control === 'radiogroup' ? D(i).options ?? [] : undefined, box: i.meta.box.w || i.meta.box.h ? i.meta.box : null, clickable: CLICKABLE.includes(D(i).control ?? '') || i.meta.tag === 'a' || i.meta.tag === 'button' || !!i.meta.pointer })),
      suggestions: [], items,
    };
    this.current.suggestions = await this.suggest(items, def, cfg);
  }

  /**
   * Open the page's address in a second tab (same session) and keep as "ready when" the first candidate that shows
   * there. Nothing shows (the address redirects, or the page only exists after a click) → the page opens through
   * the navigation map instead of its address.
   */
  private async checkDirectOpen(key: string, url: string, candidates: string[]) {
    const file = path.join(orDir(this.app), `${key}.page.yml`);
    const tab = await this.context!.newPage();
    let ready: string | undefined;
    try {
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settlePage(tab, { idle: 4000 });
      const or = new SmartOR(tab, key, { dir: orDir(this.app) });
      for (const name of candidates.slice(0, 8)) {
        const loc = await or.el(name, {}, { timeout: 1500 }).catch(() => undefined);
        if (loc && (await loc.first().isVisible().catch(() => false))) { ready = name; break; }
      }
    } catch { /* could not open it directly */ }
    await tab.close().catch(() => {});
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (ready) doc.set('readyWhen', ready);
    else doc.set('open', 'navigate');
    fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  }

  /** the OR name of a harvested element, adding it to the page file first if needed */
  private ensureElement(it: Harvested): string {
    const cur = this.current!;
    const known = cur.names.get(it);
    if (known) return known;
    const file = path.join(orDir(this.app), `${cur.key}.page.yml`);
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    const els = (doc.get('elements') as YAML.YAMLMap) ?? doc.createNode({});
    const used = new Set((els.items ?? []).map((p) => String((p.key as YAML.Scalar).value ?? p.key)));
    const name = uniqueName(it.name, used);
    els.set(name, doc.createNode(it.def));
    doc.set('elements', els);
    fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
    cur.names.set(it, name);
    return name;
  }

  private async suggest(items: Harvested[], def: NormalizedPageDef, cfg: ReturnType<typeof loadApp>): Promise<Suggestion[]> {
    const dg = await loadDatagen();
    const key = def.page;
    const out: Suggestion[] = [];
    const lazy = (it: Harvested) => () => this.ensureElement(it);
    const nameOf = (it: Harvested) => this.current!.names.get(it) ?? it.name;
    const ref = (it: Harvested) => `${key}.${nameOf(it)}`;
    const edges = readRawNavigation(this.app);
    // 1) log in
    const login = detectLoginFields(items);
    const loginItems = new Set<Harvested>();
    if (login.password && login.username && login.submit) {
      const by = (n?: string) => items.find((i) => i.name === n)!;
      const [u, p, s] = [by(login.username), by(login.password), by(login.submit)];
      [u, p, s].forEach((x) => loginItems.add(x));
      for (const user of Object.entries(cfg.users).filter(([, x]) => x.password).slice(0, 3).map(([k]) => k)) {
        out.push({ id: `login:${user}`, kind: 'login', user, label: `Log in as ${user}`, detail: 'username, password, then the login button',
          steps: [{ action: 'fill', element: ref(u), value: `{{user.${user}.username}}` }, { action: 'fill', element: ref(p), value: `{{user.${user}.password}}` }, { action: 'click', element: ref(s) }] });
      }
    }
    // 1b) find the login error message: a wrong login, nothing real is typed
    if (login.password && login.username && login.submit) {
      const by = (n?: string) => items.find((i) => i.name === n)!;
      const [u, p, sb] = [by(login.username), by(login.password), by(login.submit)];
      out.push({ id: 'probe:login', kind: 'probe', label: 'Try a wrong login — find the error message', detail: 'types an unknown user and a wrong password; the message that appears is saved and checked',
        steps: [{ action: 'fill', element: ref(u), value: 'atimtha.wrong.user' }, { action: 'fill', element: ref(p), value: 'Wrong#Pass123' }, { action: 'click', element: ref(sb) }] });
    }
    // 2) a form: fill every field with valid data and submit
    const formItems = items.filter((i) => dg.isInput(D(i).control) && !loginItems.has(i));
    if (formItems.length && !login.password) {
      const gen = dg.stepsFromPage({ page: key, elements: items.map((i) => ({ name: nameOf(i), def: i.def, params: [] })) });
      const submitStep = gen.steps.find((x) => x.action === 'click');
      const submitItem = submitStep && items.find((i) => `${key}.${nameOf(i)}` === submitStep.element);
      // only a button that really submits these fields: type=submit, in the same <form>, or named like it
      const realSubmit = !!submitItem && (submitItem.meta.type === 'submit' || (submitItem.meta.inForm && formItems.some((f) => f.meta.formIndex === submitItem.meta.formIndex))
        || /save|submit|send|confirm|book|reserve|log\s?in|sign\s?(in|up)|register|create|continue|next|apply|search|find|حفظ|إرسال|تأكيد|حجز|دخول|تسجيل|متابعة|بحث/i.test(String(submitItem.meta.name ?? submitItem.name)));
      if (realSubmit) {
        const row = { ...gen.row } as Record<string, string>;
        delete row.id; delete row.title; delete row.type;
        const ok = gen.outcomes[0]?.steps.filter((x) => x.action === 'visible') ?? [];
        const submit = gen.steps.find((x) => x.action === 'click')!;
        out.push({ id: 'probe:empty', kind: 'probe', label: 'Submit the form empty — find the error messages', detail: 'presses the submit button without filling anything; the messages that appear are saved and checked', steps: [{ ...submit }] });
        out.push({ id: 'form', kind: 'form', label: 'Fill the form with valid data and submit', detail: `${formItems.length} field(s), values from each field's meaning and rules${ok.length ? ' — then checks the success message' : ''}`, steps: gen.steps, row, expect: ok });
      }
    }
    // 3) pickers (calendar days, time slots, option lists): pick one
    for (const it of items.filter((i) => D(i).control === 'picker')) {
      const param = /\{(\w+)\}/.exec(String((it.def as { css?: string }).css))?.[1] ?? 'option';
      const value = pickValue(param, D(it).options ?? []);
      if (!value) continue;
      const opts = D(it).options ?? [];
      out.push({ id: `pick:${it.name}`, kind: 'pick', element: it.name, label: `Pick “${value.shown}” in ${nameOf(it)}`, detail: `${opts.length} choice(s): ${opts.slice(0, 6).join(', ')}${opts.length > 6 ? '…' : ''}`,
        steps: [{ action: 'click', element: `${ref(it)}(${param}=${value.value})` }] });
    }
    // 3b) single options showing now (a searched list: "Jordan" after typing "jo"): pick one
    for (const it of items.filter((i) => D(i).control === 'option').slice(0, 6)) {
      out.push({ id: `click:${it.name}`, kind: 'pick', element: it.name, label: `Choose “${String(it.meta.name || it.name).slice(0, 40)}”`, detail: 'option of an open list', steps: [{ action: 'click', element: ref(it) }] });
    }
    // 4) links and buttons
    const submitName = out.find((s) => s.kind === 'form')?.steps.find((s) => s.action === 'click')?.element;
    for (const it of items) {
      const c = D(it).control;
      if (c === 'picker' || !(c === 'button' || c === 'link' || c === 'tab' || it.meta.tag === 'a') || loginItems.has(it) || SKIP.test(`${it.name} ${String(it.meta.name ?? '')}`) || ref(it) === submitName) continue;
      const goes = edges.find((e) => e.from === key && e.steps.length === 1 && JSON.stringify(e.steps[0]).includes(`"${ref(it)}"`))?.to;
      const href = D(it).href;
      out.push({ id: `click:${it.name}`, kind: 'click', element: it.name, label: `Click “${String(it.meta.name || it.name).slice(0, 40)}”`, detail: href ? `${c ?? 'link'} → ${href}${D(it).newTab ? ' (new tab)' : ''}` : c ?? it.meta.tag, goesTo: goes, steps: [{ action: 'click', element: ref(it) }] });
      if (out.filter((s) => s.kind === 'click').length >= 14) break;
    }
    // remember how to add an element lazily when the suggestion is used
    for (const s of out) (s as Suggestion & { prepare?: () => void }).prepare = () => {
      for (const st of s.steps) {
        const ref = parseElementRef(st.element ?? '');
        const n = ref?.element;
        const args = st.element?.includes('(') ? st.element.slice(st.element.indexOf('(')) : '';
        const it = items.find((i) => nameOf(i) === n || i.name === n);
        if (it && !this.current!.names.has(it)) { const real = lazy(it)(); st.element = `${key}.${real}${args}`; }
      }
    };
    return out;
  }

  /** do a suggestion (or click a box) in the live page, then scan the page it leads to */
  async act(o: { id?: string; element?: string; option?: string; value?: string }) {
    const cur = this.current!;
    let s = o.id ? cur.suggestions.find((x) => x.id === o.id) : undefined;
    // from the element list: pick a chosen option, or type a value
    if (!s && o.element && (o.option !== undefined || o.value !== undefined)) {
      const it = cur.items.find((i) => (cur.names.get(i) ?? i.name) === o.element);
      if (!it) throw new Error(`No element "${o.element}" on this page`);
      const param = /\{(\w+)\}/.exec(String((it.def as { css?: string }).css ?? ''))?.[1];
      const step: Step = o.option !== undefined && param
        ? { action: 'click', element: `${cur.key}.${o.element}(${param}=${o.option.replace(/[(),]/g, '')})` }
        : { action: 'fill', element: `${cur.key}.${o.element}`, value: o.value ?? '' };
      const label = step.action === 'click' ? `Pick “${o.option}” in ${o.element}` : `Type “${o.value}” in ${o.element}`;
      s = { id: `manual:${o.element}`, kind: step.action === 'click' ? 'pick' : 'click', element: o.element, label, steps: [step] };
      if (!cur.names.has(it)) { const sug = s; (sug as Suggestion & { prepare?: () => void }).prepare = () => { const real = this.ensureElement(it); sug.steps[0].element = sug.steps[0].element!.replace(`${cur.key}.${o.element}`, `${cur.key}.${real}`); }; }
    }
    if (!s && o.element) {
      s = cur.suggestions.find((x) => x.kind === 'click' && (x.element === o.element || x.steps[0].element === `${cur.key}.${o.element}`));
      if (!s) {
        const el = cur.elements.find((e) => e.name === o.element);
        if (!el) throw new Error(`No element "${o.element}" on this page`);
        const pick = cur.suggestions.find((x) => x.kind === 'pick' && x.element === o.element);
        if (pick) s = pick;
      }
      if (!s) {
        const el = cur.elements.find((e) => e.name === o.element)!;
        s = { id: `click:${o.element}`, kind: 'click', label: `Click “${el.label.slice(0, 40)}”`, steps: [{ action: 'click', element: `${cur.key}.${o.element}` }] };
        // the element may not be in the OR yet → add it when used
        const it = cur.items.find((i) => (cur.names.get(i) ?? i.name) === o.element);
        if (it && !cur.names.has(it)) { const sug = s; (sug as Suggestion & { prepare?: () => void }).prepare = () => { sug.steps[0].element = `${cur.key}.${this.ensureElement(it)}`; }; }
      }
    }
    if (!s) throw new Error('That step is no longer available — the page changed');
    (s as Suggestion & { prepare?: () => void }).prepare?.();
    const from = cur.key, userBefore = this.user, page = this.page!;
    const row = s.row ? Object.fromEntries(Object.entries(s.row).map(([k, v]) => [k, this.render(v, {})])) : {};
    const cfg = loadApp(this.app);
    await watchMessages(page, cfg.testIdAttribute);
    for (const st of s.steps) await this.run(st, row);
    await this.settle();
    // messages that appeared (even toasts that are already gone) → Smart OR of the page they appeared on
    const seen = await collectMessages(page);
    this.lastFound = seen.length ? this.addMessages(this.known(page.url(), this.repo())?.page ?? from, seen) : [];
    // a dialog left open would block the next step → close it, like a tester would
    for (const f of this.lastFound.filter((x) => x.kind === 'dialog')) {
      const [pk, el] = (f.close ?? f.element).split('.');
      const loc = await new SmartOR(page, pk, { dir: orDir(this.app) }).el(el).catch(() => undefined);
      if (f.close && loc) await loc.click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape'));
      else await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
    if (s.kind === 'login') {
      this.user = s.user;
      await this.context!.storageState({ path: authFile(s.user!, this.app) }).catch(() => {}); // a saved session for later runs too
    }
    await this.scan();
    const to = this.current!.key;
    if (s.kind === 'login' && from !== to) this.rememberLogin(from, to, s.steps);
    this.journey.push({ from, to, label: s.label, kind: s.kind, steps: s.steps.map((x) => ({ ...x })), row: s.row, userBefore, url: page.url(), expect: s.expect, found: this.lastFound });
    // a click or a login that leads to another page is a route of the navigation map
    if (from !== to && s.kind !== 'form' && s.kind !== 'probe') {
      const edges = readRawNavigation(this.app);
      writeNavigation(this.app, [...edges, { from, to, steps: s.steps.map(serializeStep) }]);
    }
  }

  private addMessages(pageKey: string, seen: SeenMessage[]): FoundMessage[] { return saveMessages(this.app, pageKey, seen); }

  /** first successful login → app.yml login settings, so test runs can create saved sessions themselves */
  private rememberLogin(from: string, to: string, steps: Step[]) {
    const file = path.join(appDir(this.app), 'app.yml');
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (doc.get('login')) return;
    const name = (i: number) => steps[i]?.element?.split('.')[1];
    const ready = this.repo().get(to)?.readyWhen;
    doc.set('login', doc.createNode({ page: from, fields: { username: name(0), password: name(1), submit: name(2) }, success: ready ? { element: `${to}.${ready}` } : { urlContains: this.repo().get(to)?.url ?? '/' } }, { flow: false }));
    fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  }

  async undo() {
    if (!this.journey.length) throw new Error('Nothing to undo');
    this.journey.pop();
    await this.page!.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.settle();
    await this.scan();
  }

  /** rename a page this exploration registered (file, key, routes, journey) */
  rename(oldKey: string, newKey: string) {
    if (!this.created.has(oldKey)) throw new Error('Only pages found in this exploration can be renamed here — use ② Pages for the others');
    if (!/^[a-z][a-zA-Z0-9]*$/.test(newKey)) throw new Error('Page name: start with a lowercase letter, letters and digits only');
    const dir = orDir(this.app);
    if (fs.existsSync(path.join(dir, `${newKey}.page.yml`))) throw new Error(`A page named "${newKey}" already exists`);
    const text = fs.readFileSync(path.join(dir, `${oldKey}.page.yml`), 'utf8').replace(new RegExp(`^page: ${oldKey}$`, 'm'), `page: ${newKey}`);
    fs.writeFileSync(path.join(dir, `${newKey}.page.yml`), text);
    fs.rmSync(path.join(dir, `${oldKey}.page.yml`));
    for (const ext of ['png', 'json']) { const f = path.join(dir, '.visual', `${oldKey}.${ext}`); if (fs.existsSync(f)) fs.renameSync(f, path.join(dir, '.visual', `${newKey}.${ext}`)); }
    const swap = (r: string) => r.replace(new RegExp(`^${oldKey}\\.`), `${newKey}.`);
    writeNavigation(this.app, readRawNavigation(this.app).map((e) => ({ from: e.from === oldKey ? newKey : e.from, to: e.to === oldKey ? newKey : e.to, steps: JSON.parse(JSON.stringify(e.steps).replaceAll(`"${oldKey}.`, `"${newKey}.`)) })));
    for (const j of this.journey) { if (j.from === oldKey) j.from = newKey; if (j.to === oldKey) j.to = newKey; j.steps.forEach((s) => s.element && (s.element = swap(s.element))); }
    this.created.delete(oldKey); this.created.add(newKey);
    if (this.current?.key === oldKey) { this.current.key = newKey; this.current.suggestions.forEach((s) => s.steps.forEach((st) => st.element && (st.element = swap(st.element)))); }
  }

  /** the journey → one small case per step + a workflow chaining them in one session */
  save(name: string, module?: string): { flow: string; cases: string[] } {
    if (!this.journey.length) throw new Error('Do at least one step first');
    const repo = this.repo();
    const dir = casesDir(this.app);
    fs.mkdirSync(dir, { recursive: true });
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const files: string[] = [];
    // case names must be unique in the project (they are the test titles)
    const names = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.case.yml')).map((f) => { try { return String(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.case ?? ''); } catch { return ''; } }));
    const uniqueCase = (n: string) => { let t = n; for (let k = 2; names.has(t); k++) t = `${n} (${k})`; names.add(t); return t; };
    for (const [i, j] of mergeSamePage(this.journey).entries()) {
      const to = repo.get(j.to);
      const changed = j.from !== j.to;
      const msgChecks = (list: FoundMessage[]) => messageChecks(list);
      const okMsgs = (j.found ?? []).filter((f) => f.tone === 'success');
      const errMsgs = (j.found ?? []).filter((f) => f.tone !== 'success');
      const negative = j.kind === 'probe';
      const success: Step[] = !changed && j.expect?.length ? j.expect : !changed && okMsgs.length ? msgChecks(okMsgs) : changed && to?.readyWhen ? [{ action: 'visible', element: `${j.to}.${to.readyWhen}` }] : changed && to?.url ? [{ action: 'url', matcher: 'contains', expected: to.url }] : [];
      const error: Step[] = negative ? msgChecks(errMsgs.length ? errMsgs : j.found ?? []) : [];
      let base = slug(`${j.from} ${j.label.replace(/[“”]/g, '')}`) || `step-${i + 1}`, file = `${base}.case.yml`;
      for (let n = 2; fs.existsSync(path.join(dir, file)) || files.includes(file); n++) file = `${base}-${n}.case.yml`;
      const doc: Record<string, unknown> = {
        case: uniqueCase(`${cap(j.from)}: ${negative ? (/wrong login/i.test(j.label) ? 'Wrong login is rejected' : 'Empty form is rejected') : j.label.replace(/[“”]/g, '"')}`), description: `Recorded while exploring (${name})`, type: negative ? 'negative' : 'positive',
        ...(module ? { module } : {}), page: j.from, ...(j.userBefore ? { user: j.userBefore } : { user: 'none' }), tags: ['@explored'],
        steps: j.steps.map(serializeStep),
        ...(negative ? (error.length ? { outcomes: { error: error.map(serializeStep) } } : {}) : success.length ? { outcomes: { success: success.map(serializeStep) } } : {}),
        ...(j.row ? { data: [{ id: 'TC-001', title: 'valid data', ...j.row }] } : {}),
      };
      fs.writeFileSync(path.join(dir, file), '# Recorded by 🧭 Explore\n' + YAML.stringify(doc, { lineWidth: 0 }));
      files.push(file);
    }
    // continuing a test that ended where we started → that case is the workflow's first step, the explored ones go on from its page
    const steps = [...(this.after ? [{ case: this.after.case, ...(this.after.row ? { row: this.after.row } : {}) }] : []), ...files.map((f) => ({ case: f.replace(/\.case\.yml$/, '') }))];
    const flow = writeFlow(this.app, name, { flow: name, module, tags: ['@e2e', '@explored'], steps });
    return { flow, cases: files };
  }

  state() {
    const c = this.current;
    return {
      running: this.running, busy: this.busy, error: this.error, app: this.app, user: this.user ?? null, after: this.after ?? null,
      journey: this.journey.map(({ from, to, label, kind }) => ({ from, to, label, kind })),
      found: this.lastFound,
      page: c ? { key: c.key, isNew: c.isNew, canRename: this.created.has(c.key), url: c.url, title: c.title, shot: c.shot, size: c.size, elements: c.elements,
        suggestions: c.suggestions.map(({ id, kind, label, detail, goesTo, user }) => ({ id, kind, label, detail, goesTo, user })) } : null,
    };
  }

  // ---------------------------------------------------------------- execution
  private async run(st: Step, row: Record<string, string>) {
    const ref = parseElementRef(st.element ?? '');
    if (!ref) return;
    const or = new SmartOR(this.page!, ref.page, { dir: orDir(this.app) });
    const params = Object.fromEntries(Object.entries(ref.params).map(([k, v]) => [k, this.render(v, row)]));
    const loc = await or.el(ref.element, params, { timeout: 5000 }).catch(() => {
      throw new Error(`“${st.element}” is not on the page any more — the page changed (a list closed, a step is already done…). Pick another step, or Undo.`);
    });
    const v = this.render(st.value, row);
    switch (st.action) {
      case 'fill': await smartFill(loc, v); break;
      case 'click': {
        // a link that opens a new tab: follow it in this window so the exploration goes on
        const before = new Set(this.context!.pages());
        await loc.click();
        await this.page!.waitForTimeout(400);
        const p = this.context!.pages().find((x) => !before.has(x));
        if (p) { await p.waitForLoadState('domcontentloaded').catch(() => {}); const u = p.url(); await p.close().catch(() => {}); if (u && u !== 'about:blank') await this.page!.goto(u); }
        break;
      }
      case 'select': { const vals = v.split(/\s*,\s*/).filter(Boolean); await loc.selectOption(vals.map((label) => ({ label }))).catch(() => loc.selectOption(vals)); break; }
      case 'choose': case 'check': {
        if (!v) { await loc.first().check(); break; }
        for (const opt of v.split(/\s*,\s*/).filter(Boolean)) {
          const idx = await loc.evaluateAll((els, o) => els.findIndex((e) => ((e as HTMLInputElement).labels?.[0]?.textContent ?? e.closest('label')?.textContent ?? (e as HTMLInputElement).value).trim().toLowerCase() === o.toLowerCase() || (e as HTMLInputElement).value.toLowerCase() === o.toLowerCase()), opt);
          await loc.nth(Math.max(0, idx)).check();
        }
        break;
      }
      default: break;
    }
  }

  /** {{…}} values for the live run (the saved cases keep the templates) */
  private render(value: string | undefined, row: Record<string, string>): string {
    if (value === undefined) return '';
    const cfg = loadApp(this.app);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
      const call = /^(.*?)\((.*)\)$/.exec(expr);
      const p = (call ? call[1] : expr).split('.');
      const args = call && call[2].trim() ? call[2].split(',').map((a) => { const t = a.trim(); return /^-?\d+$/.test(t) ? Number(t) : t.replace(/^['"]|['"]$/g, ''); }) : [];
      switch (p[0]) {
        case 'data': return row[p[1]] ?? '';
        case 'user': { const u = cfg.users[p[1]]; return (p[2] === 'password' ? u?.password : u?.username) ?? ''; }
        case 'faker': {
          let fn: unknown = fakerEN; let owner: unknown = fakerEN;
          for (const k of p.slice(1)) { owner = fn; fn = (fn as Record<string, unknown>)[k]; }
          return typeof fn === 'function' ? String((fn as (...a: unknown[]) => unknown).apply(owner, args)) : '';
        }
        case 'date': return p[1] === 'iso' ? isoDate() : p[1] === 'hijri' ? hijri() : p[1] === 'plusDays' ? formatDate(addDays(new Date(), Number(args[0] ?? 0)), args[1] as string | undefined) : formatDate(new Date(), args[0] as string | undefined);
        case 'negative': { const n = (Negative as Record<string, unknown>)[p[1]]; return typeof n === 'function' ? String((n as (...a: unknown[]) => unknown)(...(args.length ? args : [256]))) : String(n ?? ''); }
        default: return '';
      }
    });
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Steps done on the same page belong together: choosing guests opens a calendar, the day shows the time slots…
 * — a later step needs the earlier ones. Consecutive steps that stay on one page become ONE case (up to and
 * including the step that leaves the page). Probes (wrong login, empty form) stay cases of their own.
 */
function mergeSamePage(journey: JourneyStep[]): JourneyStep[] {
  const out: JourneyStep[] = [];
  for (const j of journey) {
    const prev = out.at(-1);
    const joinable = prev && prev.from === prev.to && prev.to === j.from && prev.kind !== 'probe' && j.kind !== 'probe';
    if (!joinable) { out.push({ ...j, steps: [...j.steps], labels: [j.label] } as JourneyStep); continue; }
    const labels = [...((prev as JourneyStep & { labels?: string[] }).labels ?? [prev.label]), j.label];
    out[out.length - 1] = {
      ...prev, to: j.to, kind: j.kind === 'form' || prev.kind === 'form' ? 'form' : j.kind, url: j.url, expect: j.expect ?? prev.expect, found: j.found?.length ? j.found : prev.found,
      steps: [...prev.steps, ...j.steps], row: prev.row || j.row ? { ...(prev.row ?? {}), ...(j.row ?? {}) } : undefined,
      label: labels.length > 3 ? `${labels[0]} … ${labels.at(-1)} (${labels.length} steps)` : labels.join(' → '),
      labels,
    } as JourneyStep;
  }
  return out;
}

/** which choice Explore picks: a day → the first open day from tomorrow (saved as {{date.plusDays(n, d)}} so it stays valid), otherwise the first choice */
function pickValue(param: string, options: string[]): { value: string; shown: string } | undefined {
  if (!options.length) return undefined;
  if (param === 'day') {
    const today = new Date().getDate();
    const next = options.map(Number).filter((d) => d > today).sort((a, b) => a - b)[0];
    if (next) return { value: `{{date.plusDays(${next - today}, d)}}`, shown: String(next) };
  }
  const first = options.find((o) => !/^(select|choose|—|-)/i.test(o)) ?? options[0];
  return { value: first.replace(/[(),]/g, ''), shown: first };
}


/** the OR element of a page that has the same locator as a harvested element */
function matchElement(page: NormalizedPageDef, it: Harvested): string | undefined {
  const sig = (d: Partial<ElementDef>) => {
    const k = STRATEGY_KEYS.find((x) => (d as Record<string, unknown>)[x] !== undefined);
    if (!k) return '';
    const v = (d as Record<string, unknown>)[k];
    return `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}${k === 'role' ? `|${JSON.stringify(d.name ?? '')}` : ''}`;
  };
  const mine = [sig(it.def as ElementDef), ...((it.def as ElementDef).fallback ?? []).map(sig)].filter(Boolean);
  for (const [name, d] of Object.entries(page.elements)) {
    const theirs = [sig(d), ...(d.fallback ?? []).map(sig)].filter(Boolean);
    if (mine.some((m) => theirs.includes(m))) return name;
  }
  return undefined;
}

export const explorer = new Explorer();
