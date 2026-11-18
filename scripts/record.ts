/**
 * Journey recorder — the tester uses the application in a real browser; the tool turns it into
 * pages (with elements and screenshots), navigation routes and a ready test case.
 *
 *   APP=<app> tsx scripts/record.ts "<journey name>" [--start /path] [--auth <user>] [--lang ar]
 *
 * Stop with ■ Stop in the floating toolbar, by closing the browser, or from the Control Panel
 * (it creates reports/.record-stop).  Prints  @@RESULT {…}  at the end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, selectors, type Page } from '@playwright/test';
import YAML from 'yaml';
import { environment, appConfig } from '../config/environment';
import { ROOT, casesDir, orDir } from '../src/core/app';
import { readRepository } from '../src/core/or/loader';
import type { ElementDef, NormalizedPageDef } from '../src/core/or/types';
import { camel, classify, harvestPage, pickReadyElement, uniqueCandidates, uniqueName, type Harvested, type RawElement } from '../src/core/harvest';
import { pageSize, saveVisual, visualDir } from '../src/core/visual';
import { readRawNavigation, writeNavigation, type RawEdge } from '../src/core/navigation';
import { ensureApp, ensureSession } from '../src/utils/app-server';

const STOP_FILE = path.join(ROOT, 'reports', '.record-stop');
const opt = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const journey = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !['--start', '--auth', '--lang'].includes(all[i - 1])) ?? 'Recorded journey';
const startPath = opt('start') ?? '/';
const startAuth = opt('auth') && opt('auth') !== 'none' ? opt('auth') : undefined;
const OR = orDir(environment.app);
const log = (m: string) => console.log(m);

// ------------------------------------------------------------------ state
interface RecPage { key: string; path: string; isNew: boolean; items: Harvested[]; extra: Record<string, ElementDef>; def?: NormalizedPageDef; ready: Promise<void>; auth?: string }
interface RecStep { type: string; page: string; element?: string; value?: string; secret?: boolean; text?: string; as?: string; url?: string }
interface Ev { type: string; url: string; el?: RawElement; value?: string; secret?: boolean; text?: string; as?: string; name?: string; group?: string; option?: string; ts: number }

const repo = readRepository(OR);
const pages = new Map<string, RecPage>();      // by key
const byPath = new Map<string, string>();      // path → key
const steps: RecStep[] = [];
const edges: RawEdge[] = [];
const usedKeys = new Set(repo.keys());
let current: RecPage | undefined;
let lastActionAt = 0;
let sessionUser = startAuth;
let typedUser: string | undefined; // user whose username was typed last (several users may share a password)
let finished = false;
let page: Page;

const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return '/'; } };
const keyFromPath = (p: string) => {
  const segs = p.split('/').filter(Boolean).map((s) => s.replace(/\.(html?|aspx?|php|jsp)$/i, '')).filter((s) => !/^\d+$/.test(s));
  return camel(segs.slice(-2).join(' ') || 'home', 'page');
};

// ------------------------------------------------------------------ pages
function pageFor(url: string): RecPage {
  const p = pathOf(url);
  const known = byPath.get(p);
  if (known) return pages.get(known)!;
  const existing = [...repo.values()].find((d) => (d.url ?? '/').split('?')[0] === p);
  const rec: RecPage = existing
    ? { key: existing.page, path: p, isNew: false, items: [], extra: {}, def: existing, ready: Promise.resolve() }
    : { key: uniqueName(keyFromPath(p), usedKeys), path: p, isNew: true, items: [], extra: {}, ready: Promise.resolve(), auth: sessionUser };
  pages.set(rec.key, rec);
  byPath.set(p, rec.key);
  if (rec.isNew) {
    rec.ready = (async () => {
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
      if (pathOf(page.url()) !== p) return; // user already moved on
      try {
        rec.items = await harvestPage(page, environment.testIdAttribute, 60);
        saveVisual(visualDir(OR), rec.key, await page.screenshot({ fullPage: true }), {
          url: page.url(), ...(await pageSize(page)), captured: new Date().toISOString(),
          boxes: Object.fromEntries(rec.items.map((i) => [i.name, i.meta.box.w || i.meta.box.h ? i.meta.box : null])),
        });
        log(`  📄 new page "${rec.key}" (${p}) — ${rec.items.length} elements collected`);
      } catch (e) { log(`  ⚠ could not collect ${p}: ${(e as Error).message.split('\n')[0]}`); }
    })();
  } else log(`  📄 page "${rec.key}" (${p}) — already in the OR`);
  return rec;
}

function onNavigate(url: string) {
  if (finished || !/^https?:/.test(url)) return;
  const p = pathOf(url);
  if (current && current.path === p) return;
  const prev = current;
  current = pageFor(url);
  const last = steps.at(-1);
  if (prev && last && Date.now() - lastActionAt < 4000 && ['click', 'press'].includes(last.type) && last.page === prev.key) {
    // the route = the inputs typed on that page since its previous click + the click itself (e.g. a login form)
    const route: RecStep[] = [last];
    for (let i = steps.length - 2; i >= 0 && steps[i].page === prev.key && ['fill', 'select', 'choose', 'tick', 'untick', 'tickgroup', 'untickgroup'].includes(steps[i].type); i--) route.unshift(steps[i]);
    edges.push({ from: prev.key, to: current.key, steps: route.map(toRouteStep) });
    log(`  ↪ route ${prev.key} → ${current.key}`);
  } else if (prev) {
    steps.push({ type: 'goto', page: current.key, url: p });
    log(`  ↪ go to ${p}`);
  }
}

// ------------------------------------------------------------------ elements
const txt = (v: unknown) => (typeof v === 'object' && v ? Object.values(v as Record<string, string>) : [v]);
/** does a recorded element match an OR definition (primary or any fallback)? */
function same(a: RawElement, def: ElementDef | Record<string, unknown>): boolean {
  const all = [def, ...(((def as ElementDef).fallback ?? []) as Record<string, unknown>[])] as Record<string, unknown>[];
  return all.some((d) =>
    (a.testid && d.testid === a.testid) || (a.id && d.id === a.id) ||
    (d.role && d.role === a.role && d.name !== undefined && txt(d.name).includes(a.name)) ||
    (d.placeholder !== undefined && a.placeholder && txt(d.placeholder).includes(a.placeholder)) ||
    (d.label !== undefined && a.label && txt(d.label).includes(a.label)) ||
    (!a.testid && !a.id && (d.css === a.css || d.xpath === a.xpath)));
}

async function elementName(rec: RecPage, el: RawElement): Promise<string> {
  await rec.ready;
  const hit = rec.items.find((i) => same(el, i.meta as never) || same(el, i.def));
  if (hit) return hit.name;
  for (const [n, d] of Object.entries(rec.def?.elements ?? {})) if (same(el, d)) return n;
  for (const [n, d] of Object.entries(rec.extra)) if (same(el, d)) return n;
  // not collected yet (appeared after an interaction) → add it
  let candidates: Record<string, unknown>[] = [];
  if (pathOf(page.url()) === rec.path) candidates = await uniqueCandidates(page, el).catch(() => []);
  if (!candidates.length) {
    candidates = [el.testid ? { testid: el.testid } : el.id ? { id: el.id } : el.role && el.name ? { role: el.role, name: el.name, exact: true } : { css: el.css }, { xpath: el.xpath }];
  }
  const names = new Set([...rec.items.map((i) => i.name), ...Object.keys(rec.def?.elements ?? {}), ...Object.keys(rec.extra)]);
  const name = uniqueName(camel(el.hint, el.role || el.tag), names);
  const [primary, ...rest] = candidates;
  rec.extra[name] = { ...primary, ...(rest.length ? { fallback: rest.slice(0, 2) } : {}), ...classify(el) } as ElementDef;
  log(`  ＋ element "${rec.key}.${name}" added`);
  return name;
}

/** radio / checkbox group element (one element with options) for an input name */
async function groupName(rec: RecPage, group: string, type: 'radio' | 'checkbox', el: RawElement): Promise<string> {
  await rec.ready;
  const css = `input[type="${type}"][name="${group}"]`;
  const hit = rec.items.find((i) => i.def.css === css);
  if (hit) return hit.name;
  for (const [n, d] of [...Object.entries(rec.def?.elements ?? {}), ...Object.entries(rec.extra)]) if (d.css === css) return n;
  const names = new Set([...rec.items.map((i) => i.name), ...Object.keys(rec.def?.elements ?? {}), ...Object.keys(rec.extra)]);
  const name = uniqueName(camel(el.groupLabel || group, type === 'radio' ? 'choice' : 'options'), names);
  const options = pathOf(page.url()) === rec.path
    ? await page.locator(css).evaluateAll((els) => els.map((e) => ((e as HTMLInputElement).labels?.[0]?.textContent ?? (e as HTMLInputElement).value).trim())).catch(() => [])
    : [];
  rec.extra[name] = { css, control: type === 'radio' ? 'radiogroup' : 'checkgroup', ...(options.length ? { options } : {}) } as ElementDef;
  log(`  ＋ element "${rec.key}.${name}" (${type} group) added`);
  return name;
}

async function handle(ev: Ev) {
  if (finished) return;
  if (ev.type === 'stop') return finish('toolbar');
  const rec = pageFor(ev.url);
  if (!current) current = rec;
  if (ev.type === 'pageName' && ev.name) return renamePage(rec, ev.name);
  if (!ev.el) return;
  const isGroup = ['choose', 'tickgroup', 'untickgroup'].includes(ev.type) && ev.group;
  const name = isGroup ? await groupName(rec, ev.group!, ev.type === 'choose' ? 'radio' : 'checkbox', ev.el) : await elementName(rec, ev.el);
  const value = isGroup ? ev.option : ev.value;
  const s: RecStep = { type: ev.type, page: rec.key, element: name, value, secret: ev.secret, text: ev.text, as: ev.as };
  const last = steps.at(-1);
  if (s.type === 'fill' && last?.type === 'fill' && last.page === s.page && last.element === s.element) steps[steps.length - 1] = s; // keep the final value
  else steps.push(s);
  if (['click', 'press'].includes(s.type)) lastActionAt = Date.now();
  if (s.type === 'fill') {
    const users = Object.entries(appConfig.users);
    const byName = users.find(([, u]) => u.username === s.value);
    if (byName) typedUser = byName[0];
    const pwdUsers = users.filter(([, u]) => u.password && u.password === s.value).map(([k]) => k);
    if (pwdUsers.length) sessionUser = typedUser && pwdUsers.includes(typedUser) ? typedUser : pwdUsers[0];
  }
  const shown = s.secret ? '••••' : s.value !== undefined ? `"${s.value}"` : s.text ? `"${s.text.slice(0, 40)}"` : '';
  log(`  ${{ click: '🖱', fill: '⌨', select: '☰', choose: '◉', tick: '☑', untick: '☐', tickgroup: '☑', untickgroup: '☐', press: '⏎', verify: '✓', save: '💾' }[s.type] ?? '•'} ${s.type} ${rec.key}.${name} ${shown}${s.as ? ` → {{var.${s.as}}}` : ''}`);
}

function renamePage(rec: RecPage, to: string) {
  if (!rec.isNew) return log(`  ⚠ "${rec.key}" already exists in the OR — rename it from the Pages stage`);
  if (usedKeys.has(to)) return log(`  ⚠ page name "${to}" is already used`);
  const from = rec.key;
  usedKeys.delete(from); usedKeys.add(to);
  pages.delete(from); rec.key = to; pages.set(to, rec); byPath.set(rec.path, to);
  for (const s of steps) if (s.page === from) s.page = to;
  for (const e of edges) { if (e.from === from) e.from = to; if (e.to === from) e.to = to; e.steps = JSON.parse(JSON.stringify(e.steps).replaceAll(`"${from}.`, `"${to}.`)); }
  for (const ext of ['png', 'json']) { const f = path.join(visualDir(OR), `${from}.${ext}`); if (fs.existsSync(f)) fs.renameSync(f, path.join(visualDir(OR), `${to}.${ext}`)); }
  log(`  🏷 page "${from}" renamed to "${to}"`);
}

// ------------------------------------------------------------------ output
const fieldNames = new Map<string, string>(); // page.element → data field
function dataField(s: RecStep) {
  const k = `${s.page}.${s.element}`;
  if (!fieldNames.has(k)) {
    const used = new Set(fieldNames.values());
    fieldNames.set(k, uniqueName(s.element!, used));
  }
  return fieldNames.get(k)!;
}

function toCaseStep(s: RecStep): Record<string, unknown> {
  const el = `${s.page}.${s.element}`;
  switch (s.type) {
    case 'click': return { click: el };
    case 'press': return { press: { element: el, key: s.value ?? 'Enter' } };
    case 'fill': return { fill: { element: el, value: `{{data.${dataField(s)}}}` } };
    case 'select': return { select: { element: el, value: `{{data.${dataField(s)}}}` } };
    case 'choose': return { choose: { element: el, value: `{{data.${dataField(s)}}}` } };
    case 'tick': return { check: el };
    case 'untick': return { uncheck: el };
    case 'tickgroup': return { check: { element: el, value: s.value } };
    case 'untickgroup': return { uncheck: { element: el, value: s.value } };
    case 'verify': return s.text && s.text.length <= 80 ? { text: { element: el, contains: s.text } } : { visible: el };
    case 'save': return { save: { element: el, as: s.as } };
    case 'goto': return { goto: s.url };
    default: return { visible: el };
  }
}

/** route steps carry literal values (or user tokens) — routes have no data row */
function toRouteStep(s: RecStep): Record<string, unknown> {
  const el = `${s.page}.${s.element}`;
  if (s.type === 'fill') return { fill: { element: el, value: tokenFor(s.value ?? '', s.secret) } };
  if (s.type === 'select') return { select: { element: el, value: s.value ?? '' } };
  if (s.type === 'choose') return { choose: { element: el, value: s.value ?? '' } };
  return toCaseStep(s);
}

function tokenFor(value: string, secret?: boolean): string {
  const users = Object.entries(appConfig.users);
  const byName = users.find(([, u]) => value === u.username);
  if (byName) return `{{user.${byName[0]}.username}}`;
  const pwd = users.filter(([, u]) => u.password && value === u.password).map(([k]) => k);
  if (pwd.length) return `{{user.${typedUser && pwd.includes(typedUser) ? typedUser : pwd[0]}.password}}`;
  if (secret && value) log(`  ⚠ a typed password is stored in the case data — better add the user in Data & settings and use {{user.<key>.password}}`);
  return value;
}

async function finish(reason: string) {
  if (finished) return;
  finished = true;
  log(`■ Stopping (${reason}) — saving the journey…`);
  await Promise.all([...pages.values()].map((p) => p.ready.catch(() => {})));
  const result: Record<string, unknown> = { ok: true, journey, newPages: [], updatedPages: [], routes: 0, steps: steps.length };
  try {
    // 1) pages
    for (const rec of pages.values()) {
      if (rec.isNew) {
        const elements = Object.fromEntries([...rec.items.map((i) => [i.name, i.def] as const), ...Object.entries(rec.extra)]);
        if (!Object.keys(elements).length) continue;
        const doc = {
          page: rec.key, url: rec.path, description: `Recorded in "${journey}" on ${new Date().toISOString().slice(0, 10)}`,
          readyWhen: pickReadyElement(rec.items) ?? Object.keys(elements)[0], auth: rec.auth ?? 'none', tags: [`@${rec.key}`],
          settings: { timeout: 10000 }, elements,
        };
        fs.writeFileSync(path.join(OR, `${rec.key}.page.yml`), `# yaml-language-server: $schema=../../../src/core/or/or.schema.json\n` + YAML.stringify(doc, { lineWidth: 0 }));
        (result.newPages as string[]).push(rec.key);
      } else if (Object.keys(rec.extra).length) {
        const file = path.join(OR, rec.def!.file);
        fs.copyFileSync(file, file.replace(/\.page\.yml$/, `.backup-${Date.now()}.yml`));
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        for (const [n, d] of Object.entries(rec.extra)) doc.setIn(['elements', n], doc.createNode(d));
        fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
        (result.updatedPages as string[]).push(rec.key);
      }
    }
    // 2) navigation routes
    if (edges.length) { writeNavigation(environment.app, [...readRawNavigation(environment.app), ...edges]); result.routes = edges.length; }
    // 3) test case
    const caseSteps = steps.map(toCaseStep);
    const row: Record<string, unknown> = { id: 'TC-REC-001', title: journey, type: 'positive' };
    for (const s of steps) if (['fill', 'select', 'choose'].includes(s.type) && s.value !== undefined) row[dataField(s)] = tokenFor(s.value, s.secret);
    const first = steps[0]?.page ?? current?.key;
    if (caseSteps.length && first) {
      const slug = journey.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recorded-journey';
      let file = `${slug}.case.yml`, n = 2;
      while (fs.existsSync(path.join(casesDir(environment.app), file))) file = `${slug}-${n++}.case.yml`;
      fs.mkdirSync(casesDir(environment.app), { recursive: true });
      fs.writeFileSync(path.join(casesDir(environment.app), file), `# Recorded with the journey recorder on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n` +
        YAML.stringify({ case: journey, description: 'Recorded journey — add negative rows and checks in the Test builder', page: first, tags: ['@recorded'], steps: caseSteps, data: [row] }, { lineWidth: 0 }));
      result.caseFile = file;
      log(`✔ Test case → cases/${file} (${caseSteps.length} step(s))`);
    }
    if ((result.newPages as string[]).length) log(`✔ New page(s): ${(result.newPages as string[]).join(', ')}`);
    if (edges.length) log(`✔ ${edges.length} navigation route(s) added`);
  } catch (e) {
    Object.assign(result, { ok: false, error: (e as Error).message });
  }
  console.log('@@RESULT ' + JSON.stringify(result));
  fs.rmSync(STOP_FILE, { force: true });
  await page?.context().browser()?.close().catch(() => {});
  process.exit(result.ok ? 0 : 1);
}

// ------------------------------------------------------------------ main
(async () => {
  fs.rmSync(STOP_FILE, { force: true });
  const app = await ensureApp();
  selectors.setTestIdAttribute(environment.testIdAttribute);
  const storageState = await ensureSession(startAuth);
  const port = process.env.RECORD_DEBUG_PORT;
  const browser = await chromium.launch({ headless: false, channel: process.env.BROWSER_CHANNEL || undefined, args: port ? [`--remote-debugging-port=${port}`] : [] });
  const context = await browser.newContext({
    baseURL: environment.baseURL, storageState, viewport: null,
    locale: (opt('lang') ?? environment.locale) === 'ar' ? 'ar-JO' : 'en-US',
    ignoreHTTPSErrors: environment.ignoreHTTPSErrors, httpCredentials: environment.httpCredentials,
  });
  let queue = Promise.resolve();
  await context.exposeBinding('__qaRecord', (_src, ev: Ev) => { queue = queue.then(() => handle(ev)).catch((e) => log(`  ⚠ ${e.message}`)); return steps.length + 1; });
  await context.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'src/core/recorder-inpage.js'), 'utf8').replace('__TESTID_ATTR__', environment.testIdAttribute) });
  page = await context.newPage();
  // navigation goes through the same queue as the page events, so a click is always handled before the page it opens
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { const url = f.url(); queue = queue.then(() => onNavigate(url)); } });
  page.on('dialog', () => { /* leave the application's own dialogs to the tester */ });
  context.on('page', (p) => p !== page && log('  ⚠ a new tab was opened — only the first tab is recorded'));
  browser.on('disconnected', () => { queue.then(() => finish('browser closed')); });
  log(`● Recording "${journey}" on ${environment.baseURL}${startPath}${startAuth ? ` as ${startAuth}` : ''}`);
  log('  Use the browser window. Floating toolbar: ✓ Check · 💾 Save value · 🏷 Name page · ■ Stop');
  await page.goto(startPath).catch((e) => log(`  ⚠ ${e.message}`));
  const poll = setInterval(() => { if (fs.existsSync(STOP_FILE)) { clearInterval(poll); queue.then(() => finish('stopped from the Control Panel')); } }, 400);
  process.on('exit', () => app?.kill());
})().catch((e) => { console.error('✖ ' + (e.message ?? e)); console.log('@@RESULT ' + JSON.stringify({ ok: false, error: String(e.message ?? e) })); process.exit(1); });
