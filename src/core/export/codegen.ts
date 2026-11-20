/**
 * Code export — turns a project (Smart OR + cases + navigation + users + messages) into a
 * standalone, idiomatic Playwright + TypeScript project that runs WITHOUT this tool:
 *
 *   pages/<Name>Page.ts    Page Object per OR page (locators with .or() fallbacks, open(), params → methods)
 *   pages/App.ts           all page objects in one place + navigation routes
 *   tests/<case>.spec.ts   one spec per case, one test per data row, outcomes as branches
 *   data/<case>.data.ts    data rows (faker / dates / negative values as real code)
 *   tests/auth.setup.ts    login once per user → storageState
 *   support/*              small helpers (read-only fill, radio/checkbox groups, dates, messages…)
 *   .env.example           users + passwords come from environment variables, never from code
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadApp, orDir, type AppConfig } from '../app';
import { readRepository, paramsOf } from '../or/loader';
import type { ElementDef, LocalizedText, NormalizedPageDef, StrategyDef } from '../or/types';
import { readCases } from '../cases/loader';
import { outcomeFor, parseElementRef, type CaseDef, type DataRow, type Step } from '../cases/model';
import { chains, readSuites, selectRows } from '../cases/plan';
import { readFlows, type FlowDef } from '../cases/flows';
import { findRoute, readNavigation, type Edge } from '../navigation';

export type Files = Map<string, string>;

// ------------------------------------------------------------------ naming / quoting
const RESERVED = new Set(['page', 'app', 'open', 'url', 'waitReady', 't', 'constructor', 'locale', 'ready', 'name', 'default', 'delete', 'new', 'class', 'function', 'return', 'this']);
const pascal = (s: string) => s.replace(/(^|[-_\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
const camel = (s: string) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); };
const ident = (s: string) => { const c = camel(s.replace(/[^\w-]/g, '_')); return /^\d/.test(c) ? '_' + c : c; };
const elName = (s: string) => { const i = ident(s); return RESERVED.has(i) ? i + 'El' : i; };
const pageProp = (s: string) => { const i = ident(s); return RESERVED.has(i) ? i + 'Page' : i; };
const pageClass = (s: string) => pascal(ident(s)) + 'Page';
const fileBase = (s: string) => s.replace(/\.case\.ya?ml$/, '').replace(/[^\w-]/g, '-');
export const q = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const tl = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSecret = (ref?: string) => !!ref && /pass(word)?|pwd|secret|otp|pin/i.test(ref);
const indent = (code: string, n: number) => code.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

// ------------------------------------------------------------------ templates → TypeScript expressions
const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

function argList(s: string): string {
  if (!s.trim()) return '';
  return s.split(',').map((a) => {
    const t = a.trim();
    if (/^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false') return t;
    return q(t.replace(/^['"]|['"]$/g, ''));
  }).join(', ');
}

/** one {{expr}} → TS expression */
function tokenExpr(expr: string, scope: { row: string }): string {
  const call = /^(.*?)\((.*)\)$/.exec(expr);
  const pathPart = call ? call[1] : expr;
  const args = call ? argList(call[2]) : '';
  const [root, ...rest] = pathPart.split('.');
  switch (root) {
    case 'data': return `${scope.row}[${q(rest[0])}]`;
    case 'var': return `vars[${q(rest[0])}]`;
    case 'user': return rest[1] === 'password' ? `(users[${q(rest[0])}].password ?? '')` : `users[${q(rest[0])}].username`;
    case 'msg': return `msg(${q(rest[0])})`;
    case 'faker': return `String(faker.${rest.join('.')}(${args}))`;
    case 'negative': {
      const fn = ['longText', 'leadingTrailingSpaces', 'upperCase'].includes(rest[0]);
      return fn ? `Negative.${rest[0]}(${args || '256'})` : `Negative.${rest[0]}`;
    }
    case 'date': {
      const m: Record<string, string> = { today: `dates.today(${args})`, iso: 'dates.iso()', hijri: 'dates.hijri()', plusDays: `dates.plusDays(${args})` };
      if (!m[rest[0]]) throw new Error(`{{${expr}}}: unknown date function`);
      return m[rest[0]];
    }
    case 'env': return `env.${rest[0] === 'name' ? 'name' : rest[0] === 'locale' ? 'locale' : rest[0] === 'app' ? 'app' : 'baseURL'}`;
    default: throw new Error(`{{${expr}}}: unknown source "${root}"`);
  }
}

/** "Ref {{var.x}} — {{data.note}}" → `Ref ${vars['x']} — ${row['note']}` ; "abc" → 'abc' */
export function valueExpr(v: string | undefined, scope = { row: 'row' }): string {
  if (v === undefined) return "''";
  const parts = [...v.matchAll(TOKEN)];
  if (!parts.length) return q(v);
  if (parts.length === 1 && parts[0][0] === v) return tokenExpr(parts[0][1], scope);
  let out = '', last = 0;
  for (const m of parts) { out += tl(v.slice(last, m.index)) + '${' + tokenExpr(m[1], scope) + '}'; last = m.index! + m[0].length; }
  return '`' + out + tl(v.slice(last)) + '`';
}
const usesToken = (v: string | undefined, root: string) => !!v && new RegExp(`\\{\\{\\s*${root}\\.`).test(v);

// ------------------------------------------------------------------ locators
function text(v: LocalizedText): string {
  if (typeof v === 'string') return q(v);
  return v.ar ? `this.t({ en: ${q(v.en)}, ar: ${q(v.ar)} })` : q(v.en);
}
/** "{sku}" placeholders → template literal using the method's parameters */
function withParams(v: string): string {
  if (!/\{\w+\}/.test(v)) return q(v);
  return '`' + tl(v).replace(/\{(\w+)\}/g, (_, k) => '${' + k + '}') + '`';
}
function textP(v: LocalizedText): string {
  if (typeof v === 'string') return withParams(v);
  return v.ar ? `this.t({ en: ${withParams(v.en)}, ar: ${withParams(v.ar)} })` : withParams(v.en);
}

function strategyCode(s: StrategyDef, root: string): string {
  const exact = s.exact !== undefined ? `, { exact: ${s.exact} }` : '';
  if (s.testid !== undefined) return `${root}.getByTestId(${withParams(s.testid)})`;
  if (s.role !== undefined) {
    const opts = [s.name !== undefined ? `name: ${textP(s.name)}` : '', s.exact !== undefined ? `exact: ${s.exact}` : ''].filter(Boolean).join(', ');
    return `${root}.getByRole(${q(s.role)}${opts ? `, { ${opts} }` : ''})`;
  }
  if (s.label !== undefined) return `${root}.getByLabel(${textP(s.label)}${exact})`;
  if (s.placeholder !== undefined) return `${root}.getByPlaceholder(${textP(s.placeholder)}${exact})`;
  if (s.text !== undefined) return `${root}.getByText(${textP(s.text)}${exact})`;
  if (s.alt !== undefined) return `${root}.getByAltText(${textP(s.alt)}${exact})`;
  if (s.title !== undefined) return `${root}.getByTitle(${textP(s.title)}${exact})`;
  if (s.id !== undefined) return `${root}.locator(${withParams(`[id="${s.id}"]`)})`;
  if (s.css !== undefined) return `${root}.locator(${withParams(s.css)})`;
  if (s.xpath !== undefined) return `${root}.locator(${withParams('xpath=' + s.xpath)})`;
  throw new Error(`no strategy in ${JSON.stringify(s)}`);
}

function elementCode(page: NormalizedPageDef, name: string, def: ElementDef): string {
  const params = paramsOf(page, name);
  const callParent = def.within ? `this.${elName(def.within)}${paramsOf(page, def.within).length ? `(${paramsOf(page, def.within).join(', ')})` : ''}` : '';
  const root = def.within ? callParent : def.frame ? `this.page.frameLocator(${q(def.frame)})` : 'this.page';
  const mods = (c: string) => {
    if (def.hasText !== undefined) c += `.filter({ hasText: ${textP(def.hasText)} })`;
    if (def.nth !== undefined) c += `.nth(${def.nth})`;
    return c;
  };
  // .or() matches ALL its locators at once: keep only precise backups (a generic text / css / xpath backup
  // could match another element and break strict mode); the generic ones are listed in the comment
  const precise = (f: StrategyDef) => f.testid !== undefined || f.id !== undefined || f.label !== undefined || f.placeholder !== undefined || (f.role !== undefined && f.name !== undefined && f.exact === true);
  const backups = page.settings?.fallback === false ? [] : def.fallback ?? [];
  // no precise backup at all → the generic ones stay (they are the only safety net)
  const keep = backups.some(precise) ? backups.filter(precise) : backups;
  const strategies = [def, ...keep];
  const generic = backups.filter((f) => !keep.includes(f)).map((f) => JSON.stringify(f).replace(/\*\//g, '* /'));
  const chain = strategies.map((s) => mods(strategyCode(s, root)));
  const body = chain.length === 1 ? chain[0] : chain[0] + chain.slice(1).map((c) => `\n      .or(${c})`).join('');
  const doc = [def.description, def.control ? `${def.control}${def.semantic ? ` · ${def.semantic}` : ''}` : '', def.options?.length ? `options: ${def.options.join(', ')}` : '', def.format ? `format: ${def.format}` : '']
    .filter(Boolean).join(' — ');
  const comment = doc || generic.length ? `  /** ${[doc.replace(/\*\//g, '* /'), ...generic.map((g) => `backup (not used — may match other elements): ${g}`)].filter(Boolean).join('\n   *  ')} */\n` : '';
  return params.length
    ? `${comment}  ${elName(name)}(${params.map((p) => `${p}: string | number`).join(', ')}): Locator {\n    return ${body};\n  }\n`
    : `${comment}  get ${elName(name)}(): Locator {\n    return ${body};\n  }\n`;
}

// ------------------------------------------------------------------ steps → code
interface Ctx { pages: Map<string, NormalizedPageDef>; app: string; row: string }

function elementRefExpr(ref: string, ctx: Ctx): { code: string; page: string; element: string; def: ElementDef } {
  const r = parseElementRef(ref);
  if (!r) throw new Error(`bad element reference "${ref}"`);
  const pg = ctx.pages.get(r.page);
  const def = pg?.elements[r.element];
  if (!pg || !def) throw new Error(`unknown element ${r.page}.${r.element}`);
  const params = paramsOf(pg, r.element);
  const call = params.length ? `(${params.map((p) => valueExpr(r.params[p], ctx)).join(', ')})` : '';
  return { code: `${ctx.app}.${pageProp(r.page)}.${elName(r.element)}${call}`, page: r.page, element: r.element, def };
}

function stepTitle(s: Step, target: string, valueCode: string, expectedCode: string): string {
  // a template literal so the report shows the real values
  const codes: string[] = [];
  const v = (c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; };
  const shownValue = isSecret(s.element) ? '••••••••' : `"${v(valueCode)}"`;
  if (s.name) return '`' + tl(s.name) + '`';
  const t = (() => {
    switch (s.action) {
      case 'open': return `Open ${s.page} page`;
      case 'goto': return `Go to ${v(valueCode)}`;
      case 'fill': return `${target} = ${shownValue}`;
      case 'select': return `Select ${shownValue} in ${target}`;
      case 'choose': return `Choose ${shownValue} in ${target}`;
      case 'check': case 'uncheck': return `${s.action === 'check' ? 'Tick' : 'Untick'} ${s.value ? shownValue + ' in ' : ''}${target}`;
      case 'clear': return `Clear ${target}`;
      case 'click': return `Click ${target}`;
      case 'dblclick': return `Double click ${target}`;
      case 'hover': return `Hover ${target}`;
      case 'press': return `Press ${v(valueCode)}${target ? ` in ${target}` : ''}`;
      case 'save': return `Save ${target || 'page URL'} as ${s.as}`;
      case 'visible': case 'waitFor': return `${target} is visible`;
      case 'hidden': return `${target} is not visible`;
      case 'enabled': return `${target} is enabled`;
      case 'disabled': return `${target} is disabled`;
      case 'text': case 'value': case 'count': return `${target} ${s.action} ${s.matcher} "${v(expectedCode)}"`;
      case 'url': case 'title': return `Page ${s.action} ${s.matcher} "${v(expectedCode)}"`;
      case 'link': return `Link ${target} points to "${v(expectedCode)}" and answers`;
    }
  })();
  // keep the ${…} parts as code, escape only the literal text around them
  return '`' + tl(t!).replace(/\u0000(\d+)\u0000/g, (_, i) => '${' + codes[Number(i)] + '}') + '`';
}

export function stepCode(s: Step, ctx: Ctx): string {
  const V = s.action === 'goto' ? valueExpr(s.url, ctx) : valueExpr(s.value, ctx);
  const E = valueExpr(s.expected, ctx);
  const el = s.element ? elementRefExpr(s.element, ctx) : undefined;
  const L = el?.code ?? '';
  const target = el ? `${el.page}.${el.element}` : '';
  const exp = (matcher: 'contains' | 'equals', exact: string, partial: string) => (matcher === 'contains' ? partial : exact);
  let body: string;
  switch (s.action) {
    case 'open': body = `await ${ctx.app}.${pageProp(s.page!)}.open();`; break;
    case 'goto': body = `await page.goto(withBaseQuery(${V}));`; break;
    case 'fill': body = `await fill(${L}, ${V});`; break;
    case 'clear': body = `await ${L}.clear();`; break;
    case 'select': body = `await select(${L}, ${V});`; break;
    case 'choose': body = `await choose(${L}, ${V});`; break;
    case 'check': body = s.value ? `await check(${L}, ${V});` : `await ${L}.check();`; break;
    case 'uncheck': body = s.value ? `await uncheck(${L}, ${V});` : `await ${L}.uncheck();`; break;
    case 'click': body = `await ${L}.click();`; break;
    case 'dblclick': body = `await ${L}.dblclick();`; break;
    case 'hover': body = `await ${L}.hover();`; break;
    case 'press': body = el ? `await ${L}.press(${V});` : `await page.keyboard.press(${V});`; break;
    case 'visible': case 'waitFor': body = `await expect(${L}).toBeVisible();`; break;
    case 'hidden': body = `await expect(${L}).toBeHidden();`; break;
    case 'enabled': body = `await expect(${L}).toBeEnabled();`; break;
    case 'disabled': body = `await expect(${L}).toBeDisabled();`; break;
    case 'text': body = exp(s.matcher!, `await expect(${L}).toHaveText(${E});`, `await expect(${L}).toContainText(${E});`); break;
    case 'value': {
      const c = el!.def.control;
      if (c === 'radiogroup' || c === 'checkgroup' || c === 'checkbox') body = `await expectTicked(${L}, ${E}, { ${c === 'checkbox' ? 'single: true, ' : ''}contains: ${s.matcher === 'contains'} });`;
      else body = exp(s.matcher!, `await expect(${L}).toHaveValue(${E});`, `await expect(${L}).toHaveValue(new RegExp(escapeRe(${E})));`);
      break;
    }
    case 'count': body = `await expect(${L}).toHaveCount(Number(${E}));`; break;
    case 'url': body = exp(s.matcher!, `await expect(page).toHaveURL(new URL(${E}, page.url()).toString());`, `await expect(page).toHaveURL(new RegExp(escapeRe(${E})));`); break;
    case 'title': body = exp(s.matcher!, `await expect(page).toHaveTitle(${E});`, `await expect(page).toHaveTitle(new RegExp(escapeRe(${E})));`); break;
    case 'link': body = `await checkLink(page, ${L}, ${q(s.matcher ?? 'contains')}, ${E});`; break;
    case 'save': body = `vars[${q(s.as!)}] = await readValue(${el ? L : 'page'}${s.pattern ? `, new RegExp(${q(s.pattern)})` : ''});`; break;
    default: throw new Error(`action ${s.action} not supported in export`);
  }
  return `await test.step(${stepTitle(s, target, V, E)}, async () => {\n  ${body}\n});`;
}

// ------------------------------------------------------------------ project
export function generateProject(appKey: string): { files: Files; warnings: string[] } {
  const app = loadApp(appKey);
  const pages = readRepository(orDir(appKey));
  const { edges, issues: navIssues } = readNavigation(appKey, pages);
  const { cases, issues } = readCases(appKey);
  const warnings = [...navIssues, ...issues.map((i) => `${i.file}: ${i.message} (case skipped)`)];
  const files: Files = new Map();
  const defaultEnv = app.defaultEnv ?? Object.keys(app.environments)[0];

  const sessions = new Set<string>();
  // ---------- pages
  for (const p of pages.values()) files.set(`pages/${pageClass(p.page)}.ts`, pageFile(p, pages, edges, warnings));
  files.set('pages/App.ts', appFile(pages));

  // ---------- data + specs (folders per module, dependency chains in one serial spec, suites as tags)
  // API cases (engine: api) are not exported yet: the standalone project covers web cases
  for (const c of cases.filter((x) => x.engine === 'api')) warnings.push(`${c.file}: API cases are not exported yet — run them in Atimtha`);
  const valid = cases.filter((x) => !issues.some((i) => i.file === x.file) && x.engine !== 'api');
  const byId = new Map(valid.map((c) => [c.id, c]));
  const usable = valid.filter((c) => [...c.dependsOn, ...(c.continueFrom ? [c.continueFrom.case] : [])].every((d) => byId.has(d)));
  const suites = readSuites(appKey);
  const suiteTags = new Map<string, string[]>(); // `${caseId}#${row}` → ['@suite-smoke', …]
  for (const su of suites) for (const [id, rows] of selectRows(usable, su)) for (const r of rows) {
    const k = `${id}#${r}`; suiteTags.set(k, [...(suiteTags.get(k) ?? []), `@suite-${su.name}`]);
  }
  const loc = (c: CaseDef) => ({ dir: c.module ? slug(c.module) + '/' : '', base: fileBase(c.file) });
  const sc: SpecCtx = { pages, byId, loc };
  for (const c of usable) {
    try {
      files.set(`data/${loc(c).dir}${loc(c).base}.data.ts`, dataFile(c, (i) => suiteTags.get(`${c.id}#${i}`) ?? [], loc(c).dir ? '../../' : '../'));
    } catch (e) { warnings.push(`${c.file}: ${(e as Error).message} (case skipped)`); }
  }
  for (const chain of chains(usable)) {
    try {
      const first = chain[0];
      const name = chain.length === 1 ? loc(first).base : `${loc(first).base}.chain`;
      files.set(`tests/${loc(chain.at(-1)!).dir}${name}.spec.ts`, specFile(chain, sc, loc(chain.at(-1)!).dir ? '../../' : '../'));
      for (const c of chain) {
        const st = startOf(c, byId); const pg = st ? pages.get(st) : undefined;
        const u = rootUser(c, byId) ?? pg?.auth;
        if (u && u !== 'none') sessions.add(u);
      }
    } catch (e) { warnings.push(`${chain.map((c) => c.file).join(', ')}: ${(e as Error).message} (skipped)`); }
  }
  // workflows: cases chained in one session, a window per user
  for (const f of readFlows(usable, appKey).flows) {
    try {
      const { code, users } = flowFile(f, sc);
      files.set(`tests/workflows/${f.id}.flow.spec.ts`, code);
      users.forEach((u) => u !== 'none' && sessions.add(u));
    } catch (e) { warnings.push(`flows/${f.file}: ${(e as Error).message} (skipped)`); }
  }
  // sessions used by any page that a test starts on → produced by auth.setup.ts
  for (const p of pages.values()) if (p.auth && p.auth !== 'none') sessions.add(p.auth);
  if (sessions.size && !app.login) warnings.push('Pages need a logged-in session but the project has no login settings — auth.setup.ts will fail until they are added.');

  files.set('tests/auth.setup.ts', authSetup(app, [...sessions], pages));
  files.set('support/env.ts', envFile(app, defaultEnv));
  files.set('support/messages.ts', `import { env } from './env';\n\n/** Expected UI messages per language — use msg('key') */\nexport const messages: Record<string, Record<string, string>> = ${JSON.stringify(app.messages ?? {}, null, 2)};\n\nexport function msg(key: string): string {\n  const v = messages[env.locale]?.[key] ?? messages.en?.[key];\n  if (v === undefined) throw new Error(\`Message "\${key}" not found in support/messages.ts\`);\n  return v;\n}\n`);
  for (const [f, content] of Object.entries(STATIC)) files.set(f, content);
  files.set('support/fill.ts', fs.readFileSync(path.join(import.meta.dirname, '../cases/fill.ts'), 'utf8'));
  files.set('fixtures/index.ts', FIXTURES);
  files.set('playwright.config.ts', configFile(app));
  files.set('package.json', packageJson(app, suites.map((x) => x.name)));
  files.set('.env.example', envExample(app, defaultEnv));
  files.set('README.md', readme(app, cases.length, pages.size, defaultEnv, warnings, suites));
  return { files, warnings };
}

function pageFile(p: NormalizedPageDef, pages: Map<string, NormalizedPageDef>, edges: Edge[], warnings: string[]): string {
  const cls = pageClass(p.page);
  const els = Object.entries(p.elements).map(([n, d]) => elementCode(p, n, d)).join('\n');
  const ready = p.readyWhen && p.elements[p.readyWhen] && !paramsOf(p, p.readyWhen).length ? `this.${elName(p.readyWhen)}` : undefined;
  let open: string;
  if (p.open === 'navigate') {
    const route = findRoute(p.page, edges, pages);
    if (!route) {
      warnings.push(`Page "${p.page}" opens through navigation but no route reaches it — open() will throw.`);
      open = `  /** opens through the navigation map — no route was recorded */\n  async open(): Promise<void> {\n    throw new Error('No route reaches the ${p.page} page. Record one in the tool or write the steps here.');\n  }\n`;
    } else {
      const ctx: Ctx = { pages, app: 'app', row: 'row' };
      const steps = route.edges.flatMap((e) => e.steps.map((s) => stepCode(s, ctx))).join('\n');
      const needs = (re: RegExp) => re.test(steps);
      open = `  /** reached through: ${[route.start, ...route.edges.map((e) => e.to)].join(' → ')} */\n  async open(): Promise<void> {\n    const app = this.app, page = this.page;${needs(/\brow\[/) ? '\n    const row: Record<string, string> = {};' : ''}${needs(/\bvars\[/) ? '\n    const vars: Record<string, string> = {};' : ''}\n    await app.${pageProp(route.start)}.open();\n${indent(steps, 4)}\n    await this.waitReady();\n  }\n`;
    }
  } else open = '';
  const used = (name: string) => new RegExp(`\\b${name}\\(`).test(open);
  const helpers = ['fill', 'select', 'choose', 'check', 'uncheck', 'expectTicked', 'readValue', 'escapeRe', 'checkLink', 'withBaseQuery'].filter(used);
  return `import { ${open && /expect\(/.test(open) ? 'expect, ' : ''}${open && /test\.step/.test(open) ? 'test, ' : ''}type Locator, type Page } from '@playwright/test';
import { BasePage } from '../support/base.page';
import type { App } from './App';
${helpers.length ? `import { ${helpers.join(', ')} } from '../support/actions';\n` : ''}
/** ${p.description ?? p.page}${p.auth && p.auth !== 'none' ? `\n *  Needs the "${p.auth}" session.` : ''} */
export class ${cls} extends BasePage {
  readonly url = ${p.url ? q(p.url) : 'undefined'};
${p.auth && p.auth !== 'none' ? `  readonly session = ${q(p.auth)};\n` : ''}
  constructor(page: Page, app: App) {
    super(page, app);
  }
${ready ? `\n  /** the page is ready when this is visible */\n  get ready(): Locator {\n    return ${ready};\n  }\n` : ''}
${open}
${els}}
`;
}

function appFile(pages: Map<string, NormalizedPageDef>): string {
  const list = [...pages.values()];
  return `import type { Page } from '@playwright/test';
${list.map((p) => `import { ${pageClass(p.page)} } from './${pageClass(p.page)}';`).join('\n')}

/** Every page object of the application — tests receive it as the \`app\` fixture */
export class App {
${list.map((p) => `  private _${pageProp(p.page)}?: ${pageClass(p.page)};`).join('\n')}

  constructor(readonly page: Page) {}

${list.map((p) => `  get ${pageProp(p.page)}(): ${pageClass(p.page)} {\n    return (this._${pageProp(p.page)} ??= new ${pageClass(p.page)}(this.page, this));\n  }`).join('\n\n')}
}
`;
}

function dataFile(c: CaseDef, extraTags: (row: number) => string[] = () => [], up = '../'): string {
  const rows: DataRow[] = c.data.length ? c.data : [{ ...(c.type ? { type: c.type } : {}) }];
  const scope = { row: 'row' };
  const needs = { faker: false, users: false, msg: false, dates: false, env: false, Negative: false };
  const field = (v: unknown) => {
    if (typeof v !== 'string') return q(String(v));
    for (const k of ['faker', 'user', 'msg', 'date', 'env', 'negative'] as const) if (usesToken(v, k)) needs[({ user: 'users', date: 'dates', negative: 'Negative' } as Record<string, keyof typeof needs>)[k] ?? (k as keyof typeof needs)] = true;
    return valueExpr(v, scope);
  };
  const body = rows.map((r, ri) => {
    const fields = Object.entries(r).filter(([k]) => !['id', 'title', 'type', 'outcome', 'tags', 'skip'].includes(k));
    const tags = [r.type ? `@${r.type}` : '', r.id ? `@${r.id}` : '', ...(r.tags ?? []).map((t) => (t.startsWith('@') ? t : '@' + t)), ...extraTags(ri)].filter(Boolean);
    const lines = [
      r.id ? `id: ${q(r.id)},` : '', `title: ${q(r.title ?? c.case)},`, r.type ? `type: ${q(r.type)},` : '', r.outcome ? `outcome: ${q(r.outcome)},` : '',
      tags.length ? `tags: [${tags.map(q).join(', ')}],` : '', r.skip ? 'skip: true,' : '',
      `values: (faker: Faker) => ({${fields.length ? '\n' + fields.map(([k, v]) => `    ${/^\w+$/.test(k) ? k : q(k)}: ${field(v)},`).join('\n') + '\n  ' : ' '}}),`,
    ].filter(Boolean);
    return `{\n  ${lines.join('\n  ')}\n}`;
  }).join(',\n');
  const usesFaker = /faker\./.test(body);
  const imports = [
    `import type { Faker } from '@faker-js/faker';`,
    `import type { DataRow } from '../support/data';`,
    needs.users ? `import { users } from '../support/env';` : '',
    needs.env ? `import { env } from '../support/env';` : '',
    needs.msg ? `import { msg } from '../support/messages';` : '',
    needs.dates ? `import * as dates from '../support/dates';` : '',
    needs.Negative ? `import { Negative } from '../support/negative';` : '',
  ].filter(Boolean).join('\n').replace("import { users } from '../support/env';\nimport { env } from '../support/env';", "import { env, users } from '../support/env';").replaceAll("'../support/", `'${up}support/`);
  return `${imports}

/** ${c.case} — one entry = one test.${usesFaker ? ' Generated values are seeded per test (same SEED → same data).' : ''} */
export const rows: DataRow[] = [
${indent(body.replace(/\(faker: Faker\)/g, usesFaker ? '(faker: Faker)' : '(_faker: Faker)'), 2)},
];
`;
}

interface SpecCtx { pages: Map<string, NormalizedPageDef>; byId: Map<string, CaseDef>; loc: (c: CaseDef) => { dir: string; base: string } }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'module';
const startOf = (c: CaseDef, byId: Map<string, CaseDef>): string | undefined => (c.continueFrom ? startOf(byId.get(c.continueFrom.case)!, byId) : c.page);
const rowsVar = (c: CaseDef) => 'rows_' + ident(c.id);
const rootUser = (c: CaseDef, byId: Map<string, CaseDef>): string | undefined => (c.continueFrom ? rootUser(byId.get(c.continueFrom.case)!, byId) : c.user);

/** code that verifies a row: outcome chosen by the row (explicit) or its type */
function outcomeCode(c: CaseDef, ctx: Ctx, rowRef: string): string {
  const entries = Object.entries(c.outcomes);
  if (!entries.length) return '';
  const pos = outcomeFor({ type: 'positive' }, c.outcomes), neg = outcomeFor({ type: 'negative' }, c.outcomes);
  const pick = `${rowRef}.outcome ?? (${rowRef}.type === 'negative' ? ${neg ? q(neg) : 'undefined'} : ${pos ? q(pos) : 'undefined'})`;
  if (entries.length === 1 && (pos === entries[0][0] || neg === entries[0][0]) && pos === neg) return entries[0][1].map((s) => stepCode(s, ctx)).join('\n');
  const v = `outcome${ctx.row === 'row' ? '' : '_' + ctx.row}`;
  return `const ${v} = ${pick};\n` + entries.map(([k, ss], i) => `${i ? ' else ' : ''}if (${v} === ${q(k)}) {\n${indent(ss.map((s) => stepCode(s, ctx)).join('\n'), 2)}\n}`).join('');
}

/** replays the case a case continues from (recursively), with that case's row */
function continuationCode(c: CaseDef, sc: SpecCtx, used: Set<CaseDef>, depth = 1): string {
  if (!c.continueFrom) {
    if (c.url) {
      const ctx: Ctx = { pages: sc.pages, app: 'app', row: depth === 1 ? 'row' : `prev${depth - 1}` };
      return `await test.step(\`Go to \${${valueExpr(c.url, ctx)}}\`, async () => {\n  await page.goto(withBaseQuery(${valueExpr(c.url, ctx)}));${c.page ? `\n  await app.${pageProp(c.page)}.waitReady();` : ''}\n});`;
    }
    return c.page ? `await app.${pageProp(c.page)}.open();` : '';
  }
  const src = sc.byId.get(c.continueFrom.case)!;
  used.add(src);
  const row = c.continueFrom.row ? src.data.find((r) => r.id === c.continueFrom!.row) : src.data[0];
  const idx = row ? src.data.indexOf(row) : -1;
  const prev = `prev${depth}`;
  const ctx: Ctx = { pages: sc.pages, app: 'app', row: prev };
  const inner = [
    continuationCode(src, sc, used, depth + 1),
    idx >= 0 ? `const ${prev}Row = ${rowsVar(src)}[${idx}];\nconst ${prev} = ${prev}Row.values(faker);` : `const ${prev}: Record<string, string> = {};`,
    ...src.steps.map((s) => stepCode(s, ctx)),
    idx >= 0 ? outcomeCode(src, ctx, `${prev}Row`) : '',
  ].filter(Boolean).join('\n');
  return `await test.step(${q(`Continue from "${src.case}"${row?.id ? ` · ${row.id}` : ''}`)}, async () => {\n${indent(inner, 2)}\n});`;
}

function caseBlock(c: CaseDef, sc: SpecCtx, used: Set<CaseDef>, shared: boolean): string {
  used.add(c);
  const ctx: Ctx = { pages: sc.pages, app: 'app', row: 'row' };
  const start = startOf(c, sc.byId);
  const tags = [...new Set([...c.tags, ...(start ? [`@${start}`] : [])].map((t) => (t.startsWith('@') ? t : '@' + t)))];
  const startPage = start ? sc.pages.get(start) : undefined;
  const user = rootUser(c, sc.byId) ?? (startPage?.auth && startPage.auth !== 'none' ? startPage.auth : undefined);
  const session = user === 'none' ? `  test.use({ storageState: { cookies: [], origins: [] } }); // logged out\n\n` : user ? `  test.use({ storageState: sessionFile(${q(user)}) });\n\n` : '';
  const body = [
    continuationCode(c, sc, used),
    ...c.steps.map((s) => stepCode(s, ctx)),
    outcomeCode(c, ctx, 'r'),
  ].filter(Boolean).join('\n');
  return `test.describe(${q(c.case)}, { tag: [${tags.map(q).join(', ')}] }, () => {
${session}  for (const r of ${rowsVar(c)}) {
    (r.skip ? test.skip : test)(\`\${r.id ? r.id + ' · ' : ''}\${r.title}\`, { tag: r.tags ?? [] }, async ({ app, page, faker }) => {
      const row = r.values(faker);
      const vars: Record<string, string> = ${shared ? 'shared' : '{}'};
${indent(body, 6)}
    });
  }
});`;
}

function specFile(chain: CaseDef[], sc: SpecCtx, up: string): string {
  const used = new Set<CaseDef>();
  const blocks = chain.length === 1
    ? caseBlock(chain[0], sc, used, false)
    : `// These cases depend on each other: they run in this order, in one worker, and share saved values.\n// If one fails, the ones after it are skipped.\ntest.describe.serial(${q(chain.map((c) => c.case).join(' → '))}, () => {\n  const shared: Record<string, string> = {};\n\n${indent(chain.map((c) => caseBlock(c, sc, used, true)).join('\n\n'), 2)}\n});`;
  const helpers = ['fill', 'select', 'choose', 'check', 'uncheck', 'expectTicked', 'readValue', 'escapeRe', 'checkLink', 'withBaseQuery'].filter((h) => new RegExp(`\\b${h}\\(`).test(blocks));
  const needs = (re: RegExp) => re.test(blocks);
  const here = sc.loc(chain.at(-1)!).dir;
  const dataImports = [...used].map((c) => `import { rows as ${rowsVar(c)} } from '${up}data/${sc.loc(c).dir}${sc.loc(c).base}.data';`);
  const doc = chain.map((c) => ` * ${c.case}${c.description ? ` — ${c.description}` : ''}`).join('\n');
  void here;
  return `/**
${doc}
 * One data row = one test.
 */
import { test, expect${needs(/sessionFile\(/) ? ', sessionFile' : ''} } from '${up}fixtures';
${dataImports.join('\n')}
${needs(/\busers\[/) || needs(/\benv\./) ? `import { ${[needs(/\benv\./) ? 'env' : '', needs(/\busers\[/) ? 'users' : ''].filter(Boolean).join(', ')} } from '${up}support/env';\n` : ''}${needs(/\bmsg\(/) ? `import { msg } from '${up}support/messages';\n` : ''}${needs(/\bdates\./) ? `import * as dates from '${up}support/dates';\n` : ''}${needs(/\bNegative\./) ? `import { Negative } from '${up}support/negative';\n` : ''}${helpers.length ? `import { ${helpers.join(', ')} } from '${up}support/actions';\n` : ''}${needs(/\bexpect\(/) ? '' : 'void expect;\n'}
${blocks}
`;
}

/** a workflow: one test, its cases one after another in the same session; another user = that user's window */
function flowFile(f: FlowDef, sc: SpecCtx): { code: string; users: string[] } {
  const used = new Set<CaseDef>();
  const users: string[] = [];
  let previous: string | undefined;
  const opened = new Set<string>();
  const blocks = f.steps.map((s, i) => {
    const c = sc.byId.get(s.case)!;
    const start = startOf(c, sc.byId);
    const user = s.as ?? previous ?? rootUser(c, sc.byId) ?? (start ? sc.pages.get(start)?.auth : undefined) ?? 'none';
    const fresh = !opened.has(user);
    opened.add(user); users.push(user);
    const continueHere = s.start === 'continue' || (s.start !== 'open' && !fresh && i > 0);
    previous = user;
    used.add(c);
    const idx = s.row ? c.data.findIndex((r) => r.id === s.row) : c.data.length ? 0 : -1;
    const row = idx >= 0 ? c.data[idx] : undefined;
    const ctx: Ctx = { pages: sc.pages, app: 'app', row: 'row' };
    const rowRef = idx >= 0 ? `${rowsVar(c)}[${idx}]` : `({ type: ${q(c.type ?? 'positive')} } as { outcome?: string; type?: string })`;
    const body = [
      `const { app, page } = await windows.get(${q(user)});`,
      idx >= 0 ? `const row = ${rowRef}.values(faker);` : `const row: Record<string, string> = {};`,
      continueHere ? '// continues on the page the previous step ended on' : continuationCode(c, sc, used),
      ...c.steps.map((st) => stepCode(st, ctx)),
      outcomeCode(c, ctx, rowRef),
    ].filter(Boolean).join('\n');
    const who = user === 'none' ? 'no saved login' : `as ${user}`;
    const title = `${i + 1}. ${c.case}${row?.id ? ` · ${row.id}` : ''} — ${who}${continueHere ? ' · continues' : fresh && i > 0 ? ' · new window' : ''}`;
    return `await test.step(${q(title)}, async () => {\n${indent(body, 2)}\n});`;
  }).join('\n');
  const all = blocks;
  const needs = (re: RegExp) => re.test(all);
  const helpers = ['fill', 'select', 'choose', 'check', 'uncheck', 'expectTicked', 'readValue', 'escapeRe', 'checkLink', 'withBaseQuery'].filter((h) => new RegExp(`\\b${h}\\(`).test(all));
  const up = '../../';
  const tags = [...new Set(['@workflow', ...f.tags])];
  const code = `/**
 * Workflow: ${f.flow}${f.description ? `\n * ${f.description}` : ''}
 * One test: the cases run one after another in the same browser session, each continuing where the previous one ended.
 * A step as another user runs in that user's own window (its saved login). Saved values (vars) carry on.
 */
import { test, expect } from '${up}fixtures';
import { Windows } from '${up}support/windows';
${[...used].map((c) => `import { rows as ${rowsVar(c)} } from '${up}data/${sc.loc(c).dir}${sc.loc(c).base}.data';`).join('\n')}
${needs(/\busers\[/) || needs(/\benv\./) ? `import { ${[needs(/\benv\./) ? 'env' : '', needs(/\busers\[/) ? 'users' : ''].filter(Boolean).join(', ')} } from '${up}support/env';\n` : ''}${needs(/\bmsg\(/) ? `import { msg } from '${up}support/messages';\n` : ''}${needs(/\bdates\./) ? `import * as dates from '${up}support/dates';\n` : ''}${needs(/\bNegative\./) ? `import { Negative } from '${up}support/negative';\n` : ''}${helpers.length ? `import { ${helpers.join(', ')} } from '${up}support/actions';\n` : ''}${needs(/\bexpect\(/) ? '' : 'void expect;\n'}
test.describe('Workflows', () => {
  test(${q(f.flow)}, { tag: [${tags.map(q).join(', ')}] }, async ({ browser, faker }, testInfo) => {
    const windows = new Windows(browser, testInfo);
    const vars: Record<string, string> = {};
    try {
${indent(blocks, 6)}
    } catch (e) {
      windows.failed = true;
      throw e;
    } finally {
      await windows.closeAll();
    }
  });
});
`;
  return { code, users };
}

function authSetup(app: AppConfig, sessions: string[], pages: Map<string, NormalizedPageDef>): string {
  const login = app.login;
  const ok = login && pages.get(login.page);
  const lp = login ? pageProp(login.page) : '';
  const success = (() => {
    if (!login) return '';
    if (login.success?.element) {
      const [p, e] = login.success.element.split('.');
      return `await expect(app.${pageProp(p)}.${elName(e)}).toBeVisible();`;
    }
    if (login.success?.urlContains) return `await expect(page).toHaveURL(new RegExp(escapeRe(${q(login.success.urlContains)})));`;
    return `await expect(app.${lp}.${elName(login.fields.password)}).toBeHidden();`;
  })();
  return `/**
 * Runs before the tests:
 *   1) the environment answers (in the browser — WAFs often block plain API calls)
 *   2) logs in once per user and saves the session (.auth/<user>.json), reused by the tests
 */
import { test, expect, sessionFile } from '../fixtures';
import { env, users } from '../support/env';
import { escapeRe } from '../support/actions';

test('environment is reachable', async ({ page }) => {
  const res = await page.goto('/', { waitUntil: 'domcontentloaded' });
  const status = res?.status() ?? 0;
  expect(status, \`\${env.baseURL} answered \${status || 'nothing'}\`).toBeGreaterThan(0);
  expect(status, \`\${env.baseURL} has a server error (\${status})\`).toBeLessThan(500);
});

const sessions: string[] = ${JSON.stringify(sessions)};

for (const user of sessions) {
  test(\`save session: \${user}\`, async ({ app, page }) => {
${ok ? `    const u = users[user];
    if (!u?.password) throw new Error(\`No password for "\${user}" — set \${user.toUpperCase()}_PASSWORD in .env\`);
    await app.${lp}.open();
    await test.step(\`Username = "\${u.username}"\`, () => app.${lp}.${elName(login!.fields.username)}.fill(u.username));
    await test.step('Password = ••••••••', () => app.${lp}.${elName(login!.fields.password)}.fill(u.password!));
    await test.step('Login', () => app.${lp}.${elName(login!.fields.submit)}.click());
    await test.step('Logged in', async () => { ${success} });
    await page.context().storageState({ path: sessionFile(user) });` : `    throw new Error('The project has no login settings — add the login steps here.');`}
  });
}
`;
}

function envFile(app: AppConfig, defaultEnv: string): string {
  const envs = Object.fromEntries(Object.entries(app.environments).map(([k, e]) => [k, { baseURL: e.baseURL, ...(e.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}) }]));
  const users = Object.entries(app.users).map(([k, u]) => `  ${/^\w+$/.test(k) ? k : q(k)}: { username: process.env.${envKey(k)}_USERNAME ?? ${q(u.username)}, password: process.env.${envKey(k)}_PASSWORD },`).join('\n');
  return `import 'dotenv/config';

/** Environments of ${app.name} — pick one with ENV=<name> (or set BASE_URL directly) */
export const environments: Record<string, { baseURL: string; ignoreHTTPSErrors?: boolean }> = ${JSON.stringify(envs, null, 2)};

const name = process.env.ENV ?? ${q(defaultEnv)};
if (!environments[name] && !process.env.BASE_URL) throw new Error(\`Unknown ENV "\${name}". Use one of: \${Object.keys(environments).join(', ')}\`);

export const env = {
  app: ${q(app.key)},
  name,
  baseURL: process.env.BASE_URL ?? environments[name].baseURL,
  ignoreHTTPSErrors: environments[name]?.ignoreHTTPSErrors ?? false,
  locale: (process.env.LOCALE === 'ar' ? 'ar' : 'en') as 'en' | 'ar',
  testIdAttribute: ${q(app.testIdAttribute)},
  seed: Number(process.env.SEED ?? 1),
};

/** Test users — usernames can be overridden, passwords ONLY come from .env / CI secrets */
export const users: Record<string, { username: string; password?: string }> = {
${users}
};
`;
}
const envKey = (k: string) => k.replace(/[^\w]/g, '_').toUpperCase();

function envExample(app: AppConfig, defaultEnv: string): string {
  return `# Copy to .env and fill the passwords (never commit .env). A value with # or spaces goes in quotes: PASSWORD="Ab#12 3"
ENV=${defaultEnv}
# BASE_URL=https://override.example.com
LOCALE=en
SEED=1
${Object.entries(app.users).map(([k, u]) => `${envKey(k)}_USERNAME=${u.username}\n${envKey(k)}_PASSWORD=`).join('\n')}
`;
}

function configFile(app: AppConfig): string {
  return `import { defineConfig, devices } from '@playwright/test';
import { env } from './support/env';

/** ${app.name} — exported from atimtha · Automation Studio. Run: npx playwright test */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // browsers at the same time — too many on a laptop / against a slow server cause timeouts (WORKERS=… for one run)
  workers: Number(process.env.WORKERS ?? ${app.run?.workers ?? 2}),
  retries: Number(process.env.RETRIES ?? (process.env.CI ? 1 : ${app.run?.retries ?? 0})),
  timeout: Number(process.env.TEST_TIMEOUT ?? ${app.run?.testTimeout ?? 60}) * 1000,
  expect: { timeout: Number(process.env.WAIT_TIMEOUT ?? ${app.run?.waitTimeout ?? 10}) * 1000 },
  reporter: [['list'], ['html', { open: process.env.CI ? 'never' : 'on-failure' }]],
  use: {
    baseURL: env.baseURL,
    testIdAttribute: env.testIdAttribute,
    actionTimeout: Number(process.env.WAIT_TIMEOUT ?? ${app.run?.waitTimeout ?? 10}) * 2000,
    locale: env.locale === 'ar' ? 'ar-JO' : 'en-US',
    ignoreHTTPSErrors: env.ignoreHTTPSErrors,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.VIDEO === 'on' ? 'on' : 'off',
  },
  projects: [
    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],
  metadata: { app: env.app, env: env.name, locale: env.locale, seed: env.seed },
});
`;
}

function packageJson(app: AppConfig, suites: string[] = []): string {
  return JSON.stringify({
    name: `${app.key}-playwright`, version: '1.0.0', private: true, type: 'module',
    description: `${app.name} — Playwright tests exported from atimtha · Automation Studio`,
    scripts: {
      test: 'playwright test', 'test:headed': 'playwright test --headed --workers=1', 'test:ui': 'playwright test --ui',
      'test:positive': 'playwright test --grep @positive', 'test:negative': 'playwright test --grep @negative', 'test:smoke': 'playwright test --grep @smoke',
      'test:ar': 'cross-env LOCALE=ar playwright test', report: 'playwright show-report', typecheck: 'tsc --noEmit',
      ...Object.fromEntries(suites.map((n) => [`suite:${n}`, `playwright test --grep @suite-${n}`])),
    },
    devDependencies: { '@playwright/test': '1.63.0', '@faker-js/faker': '^10.0.0', '@types/node': '^22.0.0', 'cross-env': '^7.0.3', dotenv: '^16.4.5', typescript: '^5.6.0' },
  }, null, 2) + '\n';
}

function readme(app: AppConfig, cases: number, pages: number, defaultEnv: string, warnings: string[], suites: { name: string; description?: string }[] = []): string {
  return `# ${app.name} — Playwright tests

Exported from **atimtha · Automation Studio**. This is a plain Playwright + TypeScript project: it runs on its own,
without the tool. ${pages} page object(s), ${cases} test case file(s).

## Run
\`\`\`bash
npm install
npx playwright install chromium
cp .env.example .env        # fill the passwords
npx playwright test         # ENV=${defaultEnv} by default
npx playwright test --headed --workers=1
npx playwright show-report
\`\`\`
Other runs: \`ENV=<name>\`, \`BASE_URL=…\`, \`LOCALE=ar\`, \`--grep @negative\`, \`--grep @smoke\`, \`SEED=7\` (different generated data).

## Structure
| Folder | What |
|---|---|
| \`pages/\` | One Page Object per page. Each element is a locator with backups (\`.or(...)\`). \`App.ts\` holds them all. |
| \`tests/<module>/\` | One spec per test case (cases that depend on each other share one \`.chain.spec.ts\` and run in order); every data row is one test. \`auth.setup.ts\` logs in once per user. |
| \`data/<module>/\` | Test data rows. Generated values (faker, dates) are real code, seeded per test. |
| \`support/\` | Environments & users (\`env.ts\`), messages, dates, negative values, helpers for read-only fields and radio/checkbox groups. |
| \`fixtures/\` | \`app\` (all page objects) and \`faker\` (seeded) fixtures. |

## Writing a new test
\`\`\`ts
import { test, expect } from '../fixtures';

test('my test', async ({ app }) => {
  await app.login.open();
  await app.login.username.fill('standard_user');
  await expect(app.login.submit).toBeEnabled();
});
\`\`\`
Passwords live only in \`.env\` (locally) or CI secrets (\`<USER>_PASSWORD\`).
${suites.length ? `\n## Suites\n| Run | What |\n|---|---|\n${suites.map((x) => '| `npm run suite:' + x.name + '` | ' + (x.description ?? '') + ' |').join('\n')}\n` : ''}${warnings.length ? `\n## Notes from the export\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}`;
}

// ------------------------------------------------------------------ static files
const FIXTURES = `import { test as base, expect } from '@playwright/test';
import { fakerAR, fakerEN, type Faker } from '@faker-js/faker';
import path from 'node:path';
import { App } from '../pages/App';
import { env } from '../support/env';

/** saved login session of a user (created by tests/auth.setup.ts) */
export const sessionFile = (user: string) => path.join('.auth', \`\${user}.json\`);

export const test = base.extend<{ app: App; faker: Faker }>({
  app: async ({ page }, use) => use(new App(page)),
  // seeded per test: the same SEED + test always generates the same data (reproducible failures)
  faker: async ({}, use, testInfo) => {
    const faker = env.locale === 'ar' ? fakerAR : fakerEN;
    const text = \`\${env.seed}|\${testInfo.titlePath.join('>')}\`;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    faker.seed(h >>> 0);
    await use(faker);
  },
});

export { expect };
`;

const STATIC: Record<string, string> = {
  'support/base.page.ts': `import { expect, type Locator, type Page } from '@playwright/test';
import type { App } from '../pages/App';
import { env } from './env';
import { withBaseQuery } from './actions';

export abstract class BasePage {
  abstract readonly url: string | undefined;
  get ready(): Locator | undefined { return undefined; }

  constructor(readonly page: Page, protected readonly app: App) {}

  /** text in the run language */
  protected t(v: { en: string; ar?: string }): string {
    return (env.locale === 'ar' ? v.ar : undefined) ?? v.en;
  }

  async open(query = ''): Promise<void> {
    if (!this.url) throw new Error(\`\${this.constructor.name} has no URL\`);
    await this.page.goto(withBaseQuery(this.url + query));
    await this.waitReady();
  }

  async waitReady(): Promise<void> {
    if (this.ready) await expect(this.ready).toBeVisible();
  }
}
`,
  'support/actions.ts': `/** Helpers for controls that need more than a plain Playwright call */
import { expect, type Locator, type Page } from '@playwright/test';
import { smartFill } from './fill';
import { env } from './env';

/** the environment's query values (BASE_URL=https://site/?venue=abc) are added to every address of the same site */
export function withBaseQuery(target: string): string {
  let base: URL;
  try { base = new URL(env.baseURL); } catch { return target; }
  if (!base.search) return target;
  const t = new URL(target, base);
  if (t.origin !== base.origin) return target;
  for (const [k, v] of base.searchParams) if (!t.searchParams.has(k)) t.searchParams.set(k, v);
  return /^https?:/i.test(target) ? t.toString() : t.pathname + t.search + t.hash;
}


export const escapeRe = (s: string) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
const list = (v: string) => v.split(/\\s*[,،]\\s*/).filter(Boolean);

/** fill — date pickers get the browser's date format and are closed afterwards; read-only widgets get the value set directly */
export async function fill(field: Locator, value: string): Promise<void> {
  await smartFill(field, value);
}

/** dropdown — one or several options ("A, B") by label, falling back to value */
export async function select(dropdown: Locator, value: string): Promise<void> {
  const vals = list(value);
  await dropdown.selectOption(vals.map((label) => ({ label }))).catch(() => dropdown.selectOption(vals));
}

/** the input of a radio / checkbox group whose label (or value) is \`option\` */
export async function optionIn(group: Locator, option: string): Promise<Locator> {
  const idx = await group.evaluateAll((els, opt) => {
    const norm = (t: string | null | undefined) => (t ?? '').trim().replace(/\\s+/g, ' ').toLowerCase();
    const labelOf = (e: Element) => norm((e as HTMLInputElement).labels?.[0]?.textContent ?? e.closest('label')?.textContent ?? e.getAttribute('aria-label'));
    return els.findIndex((e) => labelOf(e) === norm(opt) || norm((e as HTMLInputElement).value) === norm(opt));
  }, option);
  if (idx < 0) throw new Error(\`Option "\${option}" not found in this group\`);
  return group.nth(idx);
}

export async function choose(group: Locator, option: string): Promise<void> {
  await (await optionIn(group, option)).check();
}
export async function check(group: Locator, options: string): Promise<void> {
  for (const o of list(options)) await (await optionIn(group, o)).check();
}
export async function uncheck(group: Locator, options: string): Promise<void> {
  for (const o of list(options)) await (await optionIn(group, o)).uncheck();
}

/** ticked options of a group as "A, B" (single checkbox: "checked" / "unchecked") */
export async function expectTicked(group: Locator, expected: string, opts: { single?: boolean; contains?: boolean } = {}): Promise<void> {
  const read = () => group.evaluateAll((els, single) => {
    if (single) return (els[0] as HTMLInputElement)?.checked ? 'checked' : 'unchecked';
    return els.filter((e) => (e as HTMLInputElement).checked)
      .map((e) => ((e as HTMLInputElement).labels?.[0]?.textContent ?? e.closest('label')?.textContent ?? (e as HTMLInputElement).value).trim().replace(/\\s+/g, ' '))
      .join(', ');
  }, !!opts.single);
  await expect.poll(read)[opts.contains ? 'toContain' : 'toBe'](expected);
}

/** text / field value of an element, or the page URL; optional regex keeps the first group */
export async function readValue(from: Locator | Page, pattern?: RegExp): Promise<string> {
  let raw: string;
  if ('goto' in from) raw = from.url();
  else {
    const tag = await from.evaluate((n) => n.tagName.toLowerCase());
    raw = ['input', 'textarea', 'select'].includes(tag) ? await from.inputValue() : ((await from.textContent()) ?? '').trim();
  }
  if (!pattern) return raw;
  const m = pattern.exec(raw);
  if (!m) throw new Error(\`Pattern \${pattern} did not match "\${raw}"\`);
  return m[1] ?? m[0];
}

/** a link: its address matches, and the address answers (no 4xx/5xx). mailto:/tel: links: address only. */
export async function checkLink(page: Page, link: Locator, matcher: string, expected?: string): Promise<void> {
  const href = await link.evaluate((n) => (n as HTMLAnchorElement).href || n.getAttribute('href') || '');
  if (expected) {
    if (matcher === 'equals') expect(href, 'link address').toBe(new URL(expected, page.url()).toString());
    else expect(href, 'link address').toContain(expected);
  }
  if (!/^https?:/i.test(href)) return;
  const res = await page.request.get(href, { failOnStatusCode: false, maxRedirects: 10, timeout: 20000 });
  expect(res.status(), \`link \${href} answers with HTTP \${res.status()}\`).toBeLessThan(400);
}
`,
  'support/windows.ts': `import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { App } from '../pages/App';
import { sessionFile } from '../fixtures';

/** one browser window per user inside a workflow — each with that user's saved login ('none' = no login) */
export class Windows {
  private list = new Map<string, { context: BrowserContext; page: Page; app: App }>();
  /** set when a step failed — every window then gets a screenshot in the report */
  failed = false;
  constructor(private readonly browser: Browser, private readonly info: TestInfo) {}

  async get(user: string): Promise<{ page: Page; app: App }> {
    let w = this.list.get(user);
    if (!w) {
      const use = this.info.project.use;
      const context = await this.browser.newContext({
        baseURL: use.baseURL, locale: use.locale, ignoreHTTPSErrors: use.ignoreHTTPSErrors, viewport: use.viewport,
        storageState: user === 'none' ? undefined : sessionFile(user),
      });
      if (use.actionTimeout) context.setDefaultTimeout(use.actionTimeout);
      const page = await context.newPage();
      w = { context, page, app: new App(page) };
      this.list.set(user, w);
    }
    return w;
  }

  async closeAll(): Promise<void> {
    for (const [user, w] of this.list) {
      if (this.failed) {
        await this.info.attach(\`screenshot — \${user}\`, { body: await w.page.screenshot(), contentType: 'image/png' }).catch(() => {});
      }
      await w.context.close().catch(() => {});
    }
  }
}
`,
  'support/dates.ts': `/** Dates in any format: tokens yyyy yy MM M dd d (default dd/MM/yyyy) */
const p2 = (n: number) => String(n).padStart(2, '0');

export function format(date: Date, fmt = 'dd/MM/yyyy'): string {
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()), yy: String(date.getFullYear()).slice(-2),
    MM: p2(date.getMonth() + 1), M: String(date.getMonth() + 1), dd: p2(date.getDate()), d: String(date.getDate()),
  };
  return fmt.replace(/yyyy|yy|MM|M|dd|d/g, (t) => map[t]);
}
export const today = (fmt?: string) => format(new Date(), fmt);
export const plusDays = (days: number, fmt?: string) => format(new Date(Date.now() + days * 86_400_000), fmt);
export const iso = () => new Date().toISOString().slice(0, 10);
/** Hijri (Umm al-Qura) as shown in Arabic UIs */
export const hijri = () => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
`,
  'support/negative.ts': `/** Negative / boundary values used by the negative tests */
export const Negative = {
  empty: '',
  whitespace: '   ',
  sqlInjection: "' OR '1'='1' --",
  xss: '<script>alert(1)</script>',
  htmlTag: '<b>bold</b>',
  unicode: 'ñ漢字🙂',
  arabic: 'مستخدم_تجريبي',
  rtlMixed: 'user_مستخدم_123',
  specialChars: '!@#$%^&*()_+{}|:"<>?',
  longText: (length = 256) => 'a'.repeat(length),
  leadingTrailingSpaces: (v: string) => \`  \${v}  \`,
  upperCase: (v: string) => v.toUpperCase(),
} as const;
`,
  'support/data.ts': `import type { Faker } from '@faker-js/faker';

/** one data row = one test */
export interface DataRow {
  id?: string;
  title: string;
  type?: 'positive' | 'negative';
  /** which group of checks applies (e.g. success / error) */
  outcome?: string;
  tags?: string[];
  skip?: boolean;
  /** the row's values — a function so generated data is fresh (and seeded) for every test */
  values: (faker: Faker) => Record<string, string>;
}
`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true, types: ['node'] }, include: ['**/*.ts'] }, null, 2) + '\n',
  '.gitignore': 'node_modules/\n.env\n.auth/\ntest-results/\nplaywright-report/\nblob-report/\n',
};
