/**
 * Control Panel — a local web UI so anyone in the QA team can run automation.
 *   npm run panel   → http://localhost:4400   (binds to 127.0.0.1 only)
 *
 * Applications (Setup Wizard) · run settings · tests · no-code Case Builder · pages & elements
 * · live console · Smart Report · history.
 * The panel never loads the run environment itself: every browser task runs in a child process
 * with APP / ENV / LOCALE set, exactly like the CLI.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import YAML from 'yaml';
import { ROOT, appDir, casesDir, currentApp, listApps, loadApp, orDir, setCurrentApp } from '../src/core/app';
import { readRepository, paramsOf } from '../src/core/or/loader';
import type { NormalizedPageDef } from '../src/core/or/types';
import { readCases } from '../src/core/cases/loader';
import { readSuites, writeSuites } from '../src/core/cases/plan';
import { flowsDir, readFlows, writeFlow } from '../src/core/cases/flows';
import { explorer } from '../src/core/explorer';
import { authFile } from '../src/core/pages-setup';
import { ACTIONS, MATCHERS, normalizeStep, serializeStep, type RawStep, type Step } from '../src/core/cases/model';
import { Negative } from '../src/data/negative/values';
import { loadProfiles, saveProfiles } from '../src/core/branding';
import { readNavigation, readRawNavigation, writeNavigation } from '../src/core/navigation';
import { CONTROLS, SEMANTICS, type SeenMessage } from '../src/core/harvest';
import { knownMessage, saveMessages as saveMessagesToPage, messageChecks } from '../src/core/messages';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { generateProject } from '../src/core/export/codegen';
import { checkPages } from '../src/core/page-check';
import { checkRequest, SECURITY_HEADERS } from './security';
import { parsePorcelainZ, planCommit } from './git-guard';

const PORT = Number(process.env.PANEL_PORT ?? 4400);
const PW_CLI = path.join(ROOT, 'node_modules/@playwright/test/cli.js');
const TSX_CLI = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const REPORT_DIR = path.join(ROOT, 'reports/smart-report');
const HISTORY_DIR = path.join(ROOT, 'reports/history');

// ------------------------------------------------------------------ jobs (one at a time)
interface Job { id: number; label: string; kind: string; proc?: ChildProcess; log: string[]; done: boolean; code?: number | null; started: number; ended?: number; result?: any }
let jobSeq = 0;
let current: Job | undefined;
const history: Omit<Job, 'proc' | 'log' | 'result'>[] = [];
const listeners = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}

/**
 * Environment for child processes. The panel process itself may have loaded config/environment.ts
 * (it sets APP / ENV / SEED for its own default project) — those must never leak into a run of
 * another project or freeze the data seed, so they are removed unless the run sets them.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['APP', 'ENV', 'SEED', 'LOCALE', 'SUITE', 'DETECT_LAST']) delete e[k];
  return { ...e, ...extra };
}

function startJob(kind: string, label: string, args: string[], env: Record<string, string>): Promise<Job> & { job: Job } {
  if (current && !current.done) throw new Error(`"${current.label}" is still running — wait or press Stop`);
  const job: Job = { id: ++jobSeq, kind, label, log: [], done: false, started: Date.now() };
  current = job;
  broadcast('start', { id: job.id, label, kind });
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: childEnv({ FORCE_COLOR: '0', REPORT_OPEN: 'never', ...env }) });
  job.proc = proc;
  // Output arrives in chunks (~64 KB): keep the unfinished last line until its newline arrives,
  // otherwise a long line (e.g. a result with a screenshot) is cut in pieces and cannot be read.
  const onLine = (line: string) => {
    if (!line.trim()) return;
    if (line.startsWith('@@RESULT ')) { try { job.result = JSON.parse(line.slice(9)); } catch { job.log.push('(could not read the result)'); } return; }
    const shown = line.length > 2000 ? line.slice(0, 2000) + ' …' : line;
    job.log.push(shown);
    broadcast('log', { id: job.id, line: shown });
  };
  const reader = () => {
    let rest = '';
    return {
      data: (chunk: Buffer) => {
        const lines = (rest + chunk.toString()).split(/\r?\n/);
        rest = lines.pop() ?? '';
        lines.forEach(onLine);
      },
      flush: () => { if (rest) onLine(rest); rest = ''; },
    };
  };
  const out = reader(), err = reader();
  proc.stdout.on('data', out.data);
  proc.stderr.on('data', err.data);
  const promise = new Promise<Job>((resolve) => {
    proc.on('close', (code) => {
      out.flush(); err.flush();
      Object.assign(job, { done: true, code, ended: Date.now() });
      history.unshift({ id: job.id, kind, label, done: true, code, started: job.started, ended: job.ended });
      history.splice(30);
      broadcast('done', { id: job.id, code, kind, result: job.result, report: kind === 'test' && fs.existsSync(path.join(REPORT_DIR, 'index.html')) });
      resolve(job);
    });
  }) as Promise<Job> & { job: Job };
  promise.job = job;
  return promise;
}

// ------------------------------------------------------------------ helpers
interface RunSettings {
  app?: string; env?: string; locale?: string; target?: string; project?: string; headed?: boolean;
  slowmo?: number; video?: boolean; workers?: number; retries?: number; grep?: string; seed?: string; label?: string; suite?: string;
}

const appOf = (s: { app?: string }) => {
  const a = s.app || currentApp();
  if (!listApps().includes(a)) throw new Error(`App "${a}" not found`);
  return a;
};

function envVars(s: RunSettings): Record<string, string> {
  const e: Record<string, string> = { APP: appOf(s) };
  if (s.env) {
    // a remembered environment of another project → use this project's default instead of failing
    const envs = (() => { try { return Object.keys(loadApp(e.APP).environments); } catch { return []; } })();
    if (!envs.length || envs.includes(s.env)) e.ENV = s.env;
  }
  if (s.locale) e.LOCALE = s.locale;
  if (s.target) e.TARGET = s.target;
  if (s.slowmo) e.SLOWMO = String(s.slowmo);
  if (s.video) e.VIDEO = 'on';
  if (s.seed) e.SEED = s.seed;
  if (s.suite) e.SUITE = s.suite;
  return e;
}

function safeRepo(app: string): { repo: Map<string, NormalizedPageDef>; error?: string } {
  try { return { repo: readRepository(orDir(app)) }; } catch (e) { return { repo: new Map(), error: (e as Error).message }; }
}

function pageSummary(p: NormalizedPageDef) {
  return {
    page: p.page, file: p.file, url: p.url ?? '/', description: p.description ?? '',
    auth: p.auth ?? 'none', tags: p.tags?.length ? p.tags : [`@${p.page}`], readyWhen: p.readyWhen ?? '', open: p.open ?? 'url',
    elements: Object.entries(p.elements).map(([name, def]) => ({ name, def, params: paramsOf(p, name) })),
  };
}

function listDrafts(app: string) {
  const dir = path.join(orDir(app), 'drafts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.page.yml')).map((f) => {
    const doc = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) ?? {};
    const base = f.replace(/\.page\.yml$/, '');
    return { file: f, page: doc.page, url: doc.url, elements: Object.keys(doc.elements ?? {}), defs: doc.elements ?? {}, visual: fs.existsSync(path.join(dir, `${base}.visual.png`)) };
  });
}

function listTests(env: Record<string, string>) {
  return new Promise<unknown>((resolve, reject) => {
    const p = spawn(process.execPath, [PW_CLI, 'test', '--list', '--reporter=json'], { cwd: ROOT, env: childEnv({ ...env, REPORT_OPEN: 'never' }) });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      try {
        const json = JSON.parse(out);
        const tests: unknown[] = [];
        const walk = (suite: any, describe: string[]) => {
          for (const spec of suite.specs ?? []) {
            for (const t of spec.tests ?? []) {
              if (t.projectName === 'setup') continue;
              tests.push({
                file: spec.file, line: spec.line, title: spec.title,
                tags: [...new Set<string>((spec.tags ?? []).map((x: string) => (x.startsWith('@') ? x : '@' + x)))],
                module: describe.join(' › ') || path.basename(path.dirname(spec.file)),
                source: spec.file.includes('cases.spec') ? 'no-code' : 'code',
              });
            }
          }
          for (const s of suite.suites ?? []) walk(s, s.title && !/\.ts$/.test(s.title) ? [...describe, s.title] : describe);
        };
        for (const s of json.suites ?? []) walk(s, []);
        resolve(tests);
      } catch {
        reject(new Error((err || out || 'Could not list tests').split('\n').slice(0, 15).join('\n')));
      }
    });
  });
}

function yamlFile(file: string) {
  return YAML.parseDocument(fs.readFileSync(file, 'utf8'));
}

function savePage(app: string, key: string, body: Record<string, any>) {
  const page = safeRepo(app).repo.get(key);
  if (!page) throw new Error(`Page "${key}" not found`);
  const file = path.join(orDir(app), page.file);
  const original = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(original);
  for (const k of ['url', 'auth', 'readyWhen', 'description', 'open'] as const) {
    if (body[k] === undefined) continue;
    if (body[k] === '' || (k === 'open' && body[k] === 'url')) doc.delete(k); else doc.set(k, body[k]);
  }
  if (body.tags) doc.set('tags', doc.createNode(body.tags, { flow: true }));
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  try { readRepository(orDir(app)); } catch (e) { fs.writeFileSync(file, original); throw e; }
}

/** Rename an element and every reference to it (within, readyWhen, cases, app.yml login) */
function renameElement(app: string, pageKey: string, from: string, to: string) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(to)) throw new Error('Element names are camelCase letters/digits, e.g. submitButton');
  const page = safeRepo(app).repo.get(pageKey);
  if (!page) throw new Error(`Page "${pageKey}" not found`);
  if (!page.elements[from]) throw new Error(`Element "${from}" not found`);
  if (page.elements[to]) throw new Error(`"${to}" already exists on this page`);
  const file = path.join(orDir(app), page.file);
  const doc = yamlFile(file);
  const elements = doc.get('elements') as YAML.YAMLMap;
  for (const pair of elements.items) {
    if ((pair.key as YAML.Scalar).value === from) (pair.key as YAML.Scalar).value = to;
    const v = pair.value as YAML.YAMLMap | undefined;
    if (v && YAML.isMap(v) && v.get('within') === from) v.set('within', to);
  }
  if (doc.get('readyWhen') === from) doc.set('readyWhen', to);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  // references elsewhere
  const re = new RegExp(`\\b${pageKey}\\.${from}\\b`, 'g');
  let changed = 0;
  if (fs.existsSync(casesDir(app))) {
    for (const f of fs.readdirSync(casesDir(app)).filter((x) => x.endsWith('.case.yml'))) {
      const p = path.join(casesDir(app), f), text = fs.readFileSync(p, 'utf8');
      if (re.test(text)) { fs.writeFileSync(p, text.replace(re, `${pageKey}.${to}`)); changed++; }
    }
  }
  const appFile = path.join(appDir(app), 'app.yml');
  const appDoc = yamlFile(appFile);
  let appChanged = false;
  if (appDoc.getIn(['login', 'page']) === pageKey) {
    for (const f of ['username', 'password', 'submit']) if (appDoc.getIn(['login', 'fields', f]) === from) { appDoc.setIn(['login', 'fields', f], to); appChanged = true; }
  }
  if (appDoc.getIn(['login', 'success', 'element']) === `${pageKey}.${from}`) { appDoc.setIn(['login', 'success', 'element'], `${pageKey}.${to}`); appChanged = true; }
  if (appChanged) fs.writeFileSync(appFile, appDoc.toString({ lineWidth: 0 }));
  return { casesUpdated: changed };
}

function elementUsage(app: string, pageKey: string, name: string): string[] {
  const re = new RegExp(`\\b${pageKey}\\.${name}\\b`);
  const used: string[] = [];
  if (fs.existsSync(casesDir(app))) for (const f of fs.readdirSync(casesDir(app))) if (f.endsWith('.case.yml') && re.test(fs.readFileSync(path.join(casesDir(app), f), 'utf8'))) used.push(`cases/${f}`);
  const cfg = loadApp(app);
  if (cfg.login?.page === pageKey && Object.values(cfg.login.fields).includes(name)) used.push('app.yml (login)');
  if (cfg.login?.success?.element === `${pageKey}.${name}`) used.push('app.yml (login success)');
  const page = safeRepo(app).repo.get(pageKey);
  if (page?.readyWhen === name) used.push('readyWhen of the page');
  for (const [n, d] of Object.entries(page?.elements ?? {})) if (d.within === name) used.push(`within of ${n}`);
  return used;
}

function deleteElement(app: string, pageKey: string, name: string) {
  const used = elementUsage(app, pageKey, name);
  if (used.length) throw new Error(`"${name}" is used in: ${used.join(', ')}. Change those first.`);
  const page = safeRepo(app).repo.get(pageKey)!;
  const file = path.join(orDir(app), page.file);
  const doc = yamlFile(file);
  (doc.get('elements') as YAML.YAMLMap).delete(name);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

function promoteDraft(app: string, file: string) {
  const src = path.join(orDir(app), 'drafts', path.basename(file));
  const dest = path.join(orDir(app), path.basename(file));
  if (!fs.existsSync(src)) throw new Error('Draft not found');
  if (fs.existsSync(dest)) {
    // re-harvest of an existing page: keep the old file as a backup (not loaded: no .page.yml suffix)
    fs.copyFileSync(dest, dest.replace(/\.page\.yml$/, `.backup-${Date.now()}.yml`));
  }
  fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace('$schema=../../../../src/core/or/or.schema.json', '$schema=../../../src/core/or/or.schema.json'));
  try { readRepository(orDir(app)); } catch (e) { fs.rmSync(dest); throw e; }
  fs.rmSync(src);
  const base = path.basename(file).replace(/\.page\.yml$/, '');
  const vdir = path.join(orDir(app), '.visual');
  for (const ext of ['png', 'json']) {
    const v = path.join(orDir(app), 'drafts', `${base}.visual.${ext}`);
    if (fs.existsSync(v)) { fs.mkdirSync(vdir, { recursive: true }); fs.renameSync(v, path.join(vdir, `${base}.${ext}`)); }
  }
}

function caseDetail(app: string, file: string) {
  const p = path.join(casesDir(app), path.basename(file));
  const raw = YAML.parse(fs.readFileSync(p, 'utf8')) ?? {};
  const norm = (list: unknown): (Step | { error: string; raw: unknown })[] =>
    (Array.isArray(list) ? list : []).map((s, i) => { try { return normalizeStep(s as RawStep, `#${i + 1}`); } catch (e) { return { error: (e as Error).message, raw: s }; } });
  return {
    file: path.basename(file), case: raw.case ?? '', description: raw.description ?? '', page: raw.page ?? '', tags: raw.tags ?? [],
    module: raw.module ?? '', type: raw.type ?? '', user: raw.user ?? '', url: raw.url ?? '', dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : raw.dependsOn ? [raw.dependsOn] : [],
    continueFrom: typeof raw.continueFrom === 'string' ? { case: raw.continueFrom, row: '' } : raw.continueFrom ?? null,
    steps: norm(raw.steps),
    outcomes: Object.fromEntries(Object.entries(raw.outcomes ?? {}).map(([k, v]) => [k, norm(v)])),
    data: raw.data ?? [],
  };
}

function saveCase(app: string, file: string, body: any) {
  const name = path.basename(file).replace(/\.case\.yml$/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  if (!name) throw new Error('Case file name is required');
  // the case name is the test title — two cases with the same name would stop the run
  const dir = casesDir(app);
  const clash = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.case.yml') && f !== `${name}.case.yml` && (() => { try { return String(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.case ?? '') === String(body.case || name); } catch { return false; } })()) : undefined;
  if (clash) throw new Error(`Another test case already has the name "${body.case}" (cases/${clash}) — give this one a different name`);
  const doc: Record<string, unknown> = { case: body.case || name };
  if (body.description) doc.description = body.description;
  if (body.type === 'positive' || body.type === 'negative') doc.type = body.type;
  if (body.module) doc.module = body.module;
  if (body.dependsOn?.length) doc.dependsOn = body.dependsOn;
  if (body.continueFrom?.case) doc.continueFrom = body.continueFrom.row ? { case: body.continueFrom.case, row: body.continueFrom.row } : { case: body.continueFrom.case };
  else {
    if (body.page) doc.page = body.page;
    if (body.url) doc.url = body.url;
    if (body.user) doc.user = body.user;
  }
  if (body.tags?.length) doc.tags = body.tags;
  doc.steps = (body.steps ?? []).map((s: Step) => serializeStep(s));
  const outcomes = Object.entries(body.outcomes ?? {}).filter(([k]) => k);
  if (outcomes.length) doc.outcomes = Object.fromEntries(outcomes.map(([k, v]) => [k, (v as Step[]).map(serializeStep)]));
  const RESERVED = ['id', 'title', 'type', 'outcome'];
  if (body.data?.length) doc.data = body.data.map((r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== undefined && v !== null && !(v === '' && RESERVED.includes(k)) && !(k === 'type' && doc.type && v === doc.type))));
  fs.mkdirSync(casesDir(app), { recursive: true });
  const target = path.join(casesDir(app), `${name}.case.yml`);
  fs.writeFileSync(target, `# Edited in the Control Panel Case Builder\n` + YAML.stringify(doc, { lineWidth: 0 }));
  return { file: `${name}.case.yml`, issues: readCases(app).issues.filter((i) => i.file === `${name}.case.yml`) };
}



// ------------------------------------------------------------------ what a run found (pages reached, messages that popped up)
interface DiscRef { checks?: boolean; title: string; caseFile?: string; caseId?: string; tcId?: string; kind?: string; status?: string; user?: string; flow?: boolean; type?: string; rows?: number }
function runDiscoveries(app: string, runId?: string) {
  const runs = listHistory(app);
  const run = (runId ? runs.find((r) => r.id === runId) : runs[0]) as any;
  if (!run) return { run: null, pages: [], messages: [], fixes: [] };
  const { repo } = safeRepo(app);
  const cases = (() => { try { return readCases(app).cases; } catch { return []; } })();
  const userGuess = (c: any): string | undefined => {
    if (!c) return undefined;
    if (c.user && c.user !== 'none') return c.user;
    return /\{\{\s*user\.(\w+)\./.exec(JSON.stringify([c.steps, c.data]))?.[1];
  };
  const pages = new Map<string, any>();
  const messages = new Map<string, any>();
  const add = (list: DiscRef[], r: DiscRef) => { if (!list.some((x) => x.title === r.title)) list.push(r); };
  for (const t of run.tests ?? []) {
    const d = t.discoveries;
    if (!d) continue;
    const c: any = cases.find((x) => x.file === t.caseFile);
    const ref: DiscRef = { title: t.title, caseFile: t.caseFile, caseId: c?.id, tcId: t.tcId, kind: t.kind, status: t.status, user: (t.user && t.user !== 'none' ? t.user : undefined) ?? userGuess(c), flow: !!t.caseFile?.startsWith('flows/'), type: c?.type, rows: c?.data?.length || 1 };
    const last = t.lastPage?.url?.split('#')[0];
    for (const v of d.visits ?? []) {
      let u: URL; try { u = new URL(v.url); } catch { continue; }
      const key = u.origin + u.pathname;
      const e = pages.get(key) ?? { url: v.url.split('#')[0], path: u.pathname + u.search, page: v.page, reachedBy: [] as DiscRef[], endsHere: [] as DiscRef[] };
      add(e.reachedBy, { ...ref, user: v.by && v.by !== 'none' ? v.by : ref.user });
      if (last && v.url.split('#')[0] === last) add(e.endsHere, ref);
      pages.set(key, e);
    }
    for (const m of d.messages ?? []) {
      const key = `${m.page ?? m.url}|${m.kind}|${m.text}`;
      const e = messages.get(key) ?? { ...m, tests: [] as DiscRef[], element: m.page ? knownMessage(app, m.page, m) ?? null : null };
      // does this test's case already check the message?
      add(e.tests, { ...ref, checks: !!(e.element && c && JSON.stringify([c.steps, c.outcomes]).includes(`"${m.page}.${e.element}"`)) } as DiscRef);
      messages.set(key, e);
    }
  }
  // self-healing the run did: a page recognised by other elements → offer to make it the page's "ready when"
  const fixes = new Map<string, any>();
  for (const t of run.tests ?? []) for (const h of t.healed ?? []) {
    const m = /^(\w+): "ready when" element "(\w+)" was not on the page — recognised it by (\w+)/.exec(h);
    const nav = /^(\w+): its address did not show the page — reached it through (.+?) instead/.exec(h);
    if (m && repo.get(m[1])?.readyWhen === m[2]) fixes.set(m[1], { page: m[1], kind: 'ready', from: m[2], to: m[3], text: h, tests: [...new Set([...(fixes.get(m[1])?.tests ?? []), t.title])] });
    else if (nav) fixes.set(nav[1], { page: nav[1], kind: 'navigate', via: nav[2], text: h, tests: [...new Set([...(fixes.get(nav[1])?.tests ?? []), t.title])] });
  }
  const casesOn = (pg: string) => cases.filter((c: any) => c.page === pg).length;
  const list = [...pages.values()].map((p) => ({ ...p, page: p.page && repo.has(p.page) ? p.page : null, cases: p.page ? casesOn(p.page) : 0 }));
  // new pages first, then pages where tests ended, then the rest
  list.sort((a, b) => Number(!!a.page) - Number(!!b.page) || b.endsHere.length - a.endsHere.length);
  return { run: { id: run.id, started: run.started }, pages: list, messages: [...messages.values()], fixes: [...fixes.values()] };
}

/** add message checks to a case outcome (no duplicates); text is checked only when the case has a single row */
function addChecksToCase(app: string, caseFile: string, outcome: 'success' | 'error', checks: Step[], first = false) {
  const file = path.join(casesDir(app), path.basename(caseFile));
  if (!fs.existsSync(file)) throw new Error(`Case ${caseFile} not found`);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const raw = (doc.toJSON() ?? {}) as any;
  const have = new Set(((raw.outcomes?.[outcome] ?? []) as RawStep[]).map((x) => JSON.stringify(x)));
  const add = checks.map(serializeStep).filter((x) => !have.has(JSON.stringify(x)));
  if (!add.length) return 0;
  // toasts disappear by themselves → checked first; dialogs after the existing checks
  doc.setIn(['outcomes', outcome], doc.createNode(first ? [...add, ...(raw.outcomes?.[outcome] ?? [])] : [...(raw.outcomes?.[outcome] ?? []), ...add]));
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  return add.length;
}

// ------------------------------------------------------------------ projects, settings, history, git
const yamlHeader = (schema: string) => `# yaml-language-server: $schema=${schema}\n`;

function lastRun(app: string) {
  const dir = path.join(HISTORY_DIR, app);
  if (!fs.existsSync(dir)) return undefined;
  const id = fs.readdirSync(dir).filter((x) => /^\d{8}-\d{6}/.test(x)).sort().pop();
  if (!id) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'summary.json'), 'utf8')); } catch { return undefined; }
}

function listHistory(app: string) {
  const dir = path.join(HISTORY_DIR, app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => /^\d{8}-\d{6}/.test(x)).sort().reverse().flatMap((id) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, id, 'summary.json'), 'utf8'))]; } catch { return []; }
  });
}

function projectsList() {
  return listApps().map((key) => {
    try {
      const cfg = loadApp(key);
      const pages = safeRepo(key).repo.size;
      let cases = 0, tests = 0;
      try { const r = readCases(key); cases = r.cases.length; tests = r.cases.reduce((n, c) => n + (c.data.length || 1), 0); } catch { /* ignore */ }
      const run = lastRun(key);
      return { key, name: cfg.name, description: cfg.description ?? '', envs: Object.keys(cfg.environments), baseURL: Object.values(cfg.environments)[0]?.baseURL,
        pages, cases, tests, users: Object.keys(cfg.users).length, login: !!cfg.login, branding: cfg.branding ?? 'default',
        lastRun: run ? { id: run.id, started: run.started, counts: run.counts, env: run.env } : null };
    } catch (e) { return { key, name: key, error: (e as Error).message }; }
  });
}

function createBlankProject(b: any) {
  const key = String(b.key ?? '');
  if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error('Project key must be lowercase letters, digits or "-"');
  if (listApps().includes(key)) throw new Error(`Project "${key}" already exists`);
  if (!/^https?:\/\//.test(b.baseURL ?? '')) throw new Error('Website address must start with http:// or https://');
  const dir = appDir(key);
  for (const d of ['or', 'cases', 'tests']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.yml'), yamlHeader('../../src/core/app.schema.json') + YAML.stringify({
    name: b.name || key, testIdAttribute: b.testIdAttribute || 'data-testid', languages: b.languages?.length ? b.languages : ['en'],
    environments: { [b.envName || 'uat']: { baseURL: b.baseURL } },
  }, { lineWidth: 0 }));
  fs.writeFileSync(path.join(dir, 'secrets.yml'), '# Passwords and basic-auth — git-ignored, never commit\nusers: {}\n');
  fs.writeFileSync(path.join(dir, 'messages.yml'), '# Expected UI messages — use in cases as {{msg.<key>}}\nen: {}\n');
  setCurrentApp(key);
  return { key };
}

/** Writes app.yml through a YAML document so comments survive; validates; rolls back on error */
function editAppYaml(app: string, fn: (doc: YAML.Document) => void) {
  const file = path.join(appDir(app), 'app.yml');
  const original = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(original);
  fn(doc);
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  try { loadApp(app); } catch (e) { fs.writeFileSync(file, original); throw e; }
}

function saveSettings(app: string, b: any) {
  editAppYaml(app, (doc) => {
    if (b.name !== undefined) doc.set('name', b.name);
    if (b.description !== undefined) b.description ? doc.set('description', b.description) : doc.delete('description');
    if (b.testIdAttribute) doc.set('testIdAttribute', b.testIdAttribute);
    if (b.languages) doc.set('languages', doc.createNode(b.languages, { flow: true }));
    if (b.branding !== undefined) b.branding && b.branding !== 'default' ? doc.set('branding', b.branding) : doc.delete('branding');
    if (b.environments) {
      const envs: Record<string, unknown> = {};
      for (const e of b.environments as { name: string; baseURL: string; ignoreHTTPSErrors?: boolean; startDemoApp?: boolean }[]) {
        if (!e.name || !/^[\w-]+$/.test(e.name)) throw new Error(`Environment name "${e.name}" — use letters, digits, "-" or "_"`);
        if (!/^https?:\/\//.test(e.baseURL)) throw new Error(`Environment "${e.name}": address must start with http:// or https://`);
        envs[e.name] = { baseURL: e.baseURL, ...(e.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}), ...(e.startDemoApp ? { startDemoApp: true } : {}) };
      }
      if (!Object.keys(envs).length) throw new Error('At least one environment is required');
      doc.set('environments', envs);
    }
    if (b.defaultEnv !== undefined) b.defaultEnv ? doc.set('defaultEnv', b.defaultEnv) : doc.delete('defaultEnv');
    if (b.run) {
      const r: Record<string, number> = {};
      const put = (k: string, min: number, max: number) => {
        const v = b.run[k];
        if (v === undefined || v === '' || v === null) return;
        const n = Number(v);
        if (isNaN(n) || n < min || n > max) throw new Error(`${k}: between ${min} and ${max}`);
        r[k] = n;
      };
      put('workers', 1, 16); put('retries', 0, 3); put('testTimeout', 5, 900); put('waitTimeout', 1, 120);
      Object.keys(r).length ? doc.set('run', r) : doc.delete('run');
    }
  });
}

function saveUsers(app: string, users: { key: string; username: string; password?: string; description?: string }[]) {
  const secretsFile = path.join(appDir(app), 'secrets.yml');
  const secrets = fs.existsSync(secretsFile) ? YAML.parse(fs.readFileSync(secretsFile, 'utf8')) ?? {} : {};
  secrets.users ??= {};
  const map: Record<string, unknown> = {};
  for (const u of users) {
    if (!u.key || !/^[\w-]+$/.test(u.key)) throw new Error(`User key "${u.key}" — use letters, digits, "-" or "_"`);
    if (!u.username) throw new Error(`User "${u.key}" needs a username`);
    map[u.key] = { username: u.username, ...(u.description ? { description: u.description } : {}) };
    if (u.password) secrets.users[u.key] = { ...(secrets.users[u.key] ?? {}), password: u.password };
  }
  for (const k of Object.keys(secrets.users)) if (!map[k]) delete secrets.users[k];
  editAppYaml(app, (doc) => (Object.keys(map).length ? doc.set('users', map) : doc.delete('users')));
  fs.writeFileSync(secretsFile, '# Passwords and basic-auth — git-ignored, never commit\n' + YAML.stringify(secrets));
}

function saveLogin(app: string, b: any) {
  editAppYaml(app, (doc) => {
    if (!b || !b.page) return void doc.delete('login');
    const success = b.success?.element ? { element: b.success.element } : b.success?.urlContains ? { urlContains: b.success.urlContains } : undefined;
    doc.set('login', { page: b.page, fields: { username: b.fields.username, password: b.fields.password, submit: b.fields.submit }, ...(success ? { success } : {}) });
  });
}

function saveMessages(app: string, rows: { key: string; en: string; ar?: string }[]) {
  const out: Record<string, Record<string, string>> = { en: {} };
  const langs = loadApp(app).languages;
  if (langs.includes('ar')) out.ar = {};
  for (const r of rows) {
    if (!r.key) continue;
    if (!/^\w+$/.test(r.key)) throw new Error(`Message key "${r.key}" — letters, digits and "_" only`);
    out.en[r.key] = r.en ?? '';
    if (out.ar) out.ar[r.key] = r.ar ?? '';
  }
  fs.writeFileSync(path.join(appDir(app), 'messages.yml'), '# Expected UI messages — use in cases as {{msg.<key>}}; the run language picks the column\n' + YAML.stringify(out, { lineWidth: 0 }));
}

function setElementMeta(app: string, pageKey: string, name: string, meta: { control?: string; semantic?: string; format?: string; rules?: Record<string, unknown> }) {
  const page = safeRepo(app).repo.get(pageKey);
  if (!page?.elements[name]) throw new Error(`Element "${name}" not found`);
  const file = path.join(orDir(app), page.file);
  const original = fs.readFileSync(file, 'utf8');
  const doc = yamlFile(file);
  const node = doc.getIn(['elements', name]);
  if (!YAML.isMap(node)) throw new Error(`"${name}" is written as a shorthand — collect the page again to edit its details`);
  for (const k of ['control', 'semantic', 'format'] as const) if (meta[k] !== undefined) meta[k] ? node.set(k, meta[k]) : node.delete(k);
  if (meta.rules !== undefined) {
    const rules = Object.fromEntries(Object.entries(meta.rules).filter(([, v]) => v !== '' && v !== null && v !== false && v !== undefined));
    Object.keys(rules).length ? node.set('rules', doc.createNode(rules, { flow: true })) : node.delete('rules');
  }
  fs.writeFileSync(file, doc.toString({ lineWidth: 0 }));
  try { readRepository(orDir(app)); } catch (e) { fs.writeFileSync(file, original); throw e; }
}

function git(args: string[]) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitStatus() {
  try { git(['rev-parse', '--is-inside-work-tree']); } catch { return { repo: false }; }
  const branch = (() => { try { return git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return '(no commits yet)'; } })();
  const plan = gitPlan();
  const changes = [
    ...plan.commit.map((c) => ({ status: c.status.trim(), file: c.file, commit: true })),
    ...plan.blocked.map((b) => ({ status: b.change.status.trim(), file: b.change.file, commit: false, blocked: true, reason: b.reason })),
    ...plan.skipped.map((s) => ({ status: s.change.status.trim(), file: s.change.file, commit: false, reason: s.reason })),
  ];
  const remote = (() => { try { return git(['remote', 'get-url', 'origin']); } catch { return ''; } })();
  return { repo: true, branch, changes, remote };
}
function gitInit() {
  if (gitStatus().repo) return gitStatus();
  git(['init', '-b', 'main']);
  return gitStatus();
}
/** passwords and keys from every project's secrets.yml — finding one in a committed file is a leak */
function knownSecrets(): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'string' && /pass|secret|token|key/i.test(key) && !/^\$\{\w+\}$/.test(v)) out.push(v);
  };
  for (const app of listApps()) {
    const f = path.join(appDir(app), 'secrets.yml');
    if (fs.existsSync(f)) { try { walk(YAML.parse(fs.readFileSync(f, 'utf8'))); } catch { /* unreadable secrets file: nothing to compare */ } }
  }
  return out;
}
const readWorkspaceText = (file: string) => {
  try { const b = fs.readFileSync(path.join(ROOT, file)); return b.includes(0) ? undefined : b.toString('utf8'); } catch { return undefined; }
};
function gitPlan() {
  const out = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return planCommit(parsePorcelainZ(out), readWorkspaceText, knownSecrets());
}
function gitCommit(message: string) {
  if (!message?.trim()) throw new Error('Write a commit message');
  const plan = gitPlan();
  if (plan.blocked.length) throw new Error(`Blocked, nothing committed: ${plan.blocked.map((b) => `${b.change.file} (${b.reason})`).join('; ')}`);
  if (!plan.commit.length) throw new Error(plan.skipped.length ? 'Nothing to commit in project files (apps/, branding/). The other changes need your Git client.' : 'Nothing to commit');
  // stage and commit exactly these paths (literal pathspecs, NUL-separated, no command-line length limit)
  const paths = plan.commit.flatMap((c) => (c.from ? [c.from, c.file] : [c.file]));
  const list = path.join(os.tmpdir(), `atimtha-commit-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(list, paths.join('\0'));
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
  const run = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  try {
    run(['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
    run(['commit', '-m', message, `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? String(e);
    if (/user\.(name|email)|Please tell me who you are/i.test(msg)) throw new Error('Git does not know who you are yet. Run once: git config --global user.name "Your Name" && git config --global user.email you@company.com');
    throw new Error(msg);
  } finally {
    fs.rmSync(list, { force: true });
  }
  return { ...gitStatus(), committed: plan.commit.length, left: plan.skipped.length };
}

function exportProject(app: string): Buffer {
  const zip = new AdmZip();
  const dir = appDir(app);
  const walk = (d: string, rel: string) => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f), r = path.join(rel, f);
      if (/^(secrets\.ya?ml|\.visual|drafts)$/.test(f) || /\.backup-/.test(f)) continue;
      fs.statSync(full).isDirectory() ? walk(full, r) : zip.addLocalFile(full, path.dirname(r));
    }
  };
  walk(dir, app);
  return zip.toBuffer();
}

function importProject(b64: string, overwrite = false) {
  const zip = new AdmZip(Buffer.from(b64, 'base64'));
  const entries = zip.getEntries();
  const appYml = entries.find((e) => /^[^/]+\/app\.yml$/.test(e.entryName));
  if (!appYml) throw new Error('This zip is not a project export (no <project>/app.yml inside)');
  const key = appYml.entryName.split('/')[0];
  if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Invalid project folder "${key}"`);
  if (listApps().includes(key) && !overwrite) throw new Error(`Project "${key}" already exists`);
  for (const e of entries) {
    if (e.isDirectory) continue;
    const target = path.normalize(path.join(APPS_ROOT, e.entryName));
    if (!target.startsWith(path.join(APPS_ROOT, key) + path.sep)) continue; // zip-slip guard
    if (/secrets\.ya?ml$/.test(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
  }
  if (!fs.existsSync(path.join(appDir(key), 'secrets.yml'))) fs.writeFileSync(path.join(appDir(key), 'secrets.yml'), '# Passwords — git-ignored\nusers: {}\n');
  loadApp(key);
  return { key };
}
const APPS_ROOT = path.join(ROOT, 'apps');

// ------------------------------------------------------------------ http
const json = (res: http.ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.webm': 'video/webm', '.zip': 'application/zip', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serveStatic(res: http.ServerResponse, base: string, rel: string) {
  const file = path.normalize(path.join(base, rel || 'index.html'));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
const wizard = (cmd: string, input: unknown, env: Record<string, string> = {}) =>
  startJob('wizard', `Setup wizard · ${cmd}`, [TSX_CLI, 'scripts/wizard.ts', cmd, Buffer.from(JSON.stringify(input)).toString('base64')], env);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  let m: RegExpMatchArray | null;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const header = (k: string) => { const v = req.headers[k]; return Array.isArray(v) ? v[0] : v; };
  const rejected = checkRequest({
    method: req.method ?? 'GET', path: p, port: PORT,
    host: header('host'), origin: header('origin'), secFetchSite: header('sec-fetch-site'), secFetchMode: header('sec-fetch-mode'), contentType: header('content-type'),
  });
  if (rejected) {
    console.warn(`[panel] blocked ${req.method} ${p}: ${rejected.error}`);
    return json(res, rejected.status, { error: rejected.error });
  }
  try {
    if (req.method === 'GET' && p === '/') return serveStatic(res, path.join(ROOT, 'panel'), 'index.html');
    if (req.method === 'GET' && (p.startsWith('/app/') || p.startsWith('/vendor/'))) return serveStatic(res, path.join(ROOT, 'panel'), p.slice(1));
    if (req.method === 'GET' && p.startsWith('/report/')) return serveStatic(res, REPORT_DIR, decodeURIComponent(p.slice(8)));
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }



    // ---------------- journey recorder & navigation
    if (p === '/api/record' && req.method === 'POST') {
      const b = await readBody(req);
      const args = [TSX_CLI, 'scripts/record.ts', b.name || 'Recorded journey', '--start', b.start || '/'];
      if (b.auth && b.auth !== 'none') args.push('--auth', b.auth);
      if (b.locale) args.push('--lang', b.locale);
      startJob('record', `Recording "${b.name || 'journey'}"`, args, envVars(b));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/record/stop' && req.method === 'POST') {
      fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'reports', '.record-stop'), String(Date.now()));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/navigation' && req.method === 'PUT') {
      const b = await readBody(req);
      const app = appOf(b);
      const edges = (b.edges ?? []).map((e: { from: string; to: string; steps: Step[] }) => ({ from: e.from, to: e.to, steps: e.steps.map((st) => serializeStep(st)) }));
      writeNavigation(app, edges);
      return json(res, 200, { ok: true, issues: readNavigation(app).issues });
    }

    // ---------------- projects
    if (req.method === 'GET' && p === '/api/projects') return json(res, 200, projectsList());
    if (req.method === 'POST' && p === '/api/projects') return json(res, 200, { ok: true, ...createBlankProject(await readBody(req)) });
    if (req.method === 'POST' && p === '/api/projects/import') { const b = await readBody(req); return json(res, 200, { ok: true, ...importProject(b.zip, b.overwrite) }); }
    if ((m = p.match(/^\/api\/projects\/([a-z][a-z0-9-]*)\/export-code$/)) && req.method === 'GET') {
      const app = appOf({ app: m[1] });
      const { files, warnings } = generateProject(app);
      const zip = new AdmZip();
      for (const [rel, content] of files) zip.addFile(`${app}-playwright/${rel}`, Buffer.from(content, 'utf8'));
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${app}-playwright.zip"`, 'x-export-warnings': encodeURIComponent(JSON.stringify(warnings)) });
      return res.end(zip.toBuffer());
    }
    if ((m = p.match(/^\/api\/projects\/([a-z][a-z0-9-]*)\/export$/)) && req.method === 'GET') {
      const buf = exportProject(appOf({ app: m[1] }));
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${m[1]}-project.zip"` });
      return res.end(buf);
    }
    if ((m = p.match(/^\/api\/projects\/([a-z][a-z0-9-]*)\/(settings|users|login|messages)$/)) && req.method === 'PUT') {
      const app = appOf({ app: m[1] }), b = await readBody(req);
      if (m[2] === 'settings') saveSettings(app, b);
      if (m[2] === 'users') saveUsers(app, b.users ?? []);
      if (m[2] === 'login') saveLogin(app, b.login);
      if (m[2] === 'messages') saveMessages(app, b.messages ?? []);
      return json(res, 200, { ok: true });
    }
    // ---------------- visuals
    if (req.method === 'GET' && (m = p.match(/^\/visual\/([a-z][a-z0-9-]*)\/(drafts\/)?([\w.-]+\.(png|json))$/))) {
      return serveStatic(res, path.join(orDir(m[1]), m[2] ? 'drafts' : '.visual'), m[3]);
    }
    if ((m = p.match(/^\/api\/pages\/([a-zA-Z0-9]+)\/capture$/)) && req.method === 'POST') {
      const s = await readBody(req);
      startJob('capture', `Refresh screenshot of "${m[1]}"`, [TSX_CLI, 'scripts/capture-page.ts', m[1]], envVars(s));
      return json(res, 200, { ok: true });
    }
    // ---------------- 🩺 check pages: each page opens by its address and becomes ready
    if (req.method === 'POST' && p === '/api/pages/check') { const b = await readBody(req); return json(res, 200, { results: await checkPages(appOf(b), b.env) }); }
    if (req.method === 'POST' && p === '/api/pages/ready') {
      const b = await readBody(req);
      const app = appOf(b);
      const file = [...safeRepo(app).repo.values()].find((d) => d.page === b.page)?.file;
      if (!file) throw new Error(`Page "${b.page}" not found`);
      const fp = path.join(orDir(app), file);
      const doc = YAML.parseDocument(fs.readFileSync(fp, 'utf8'));
      if (b.readyWhen) doc.set('readyWhen', String(b.readyWhen));
      if (b.open === 'navigate') doc.set('open', 'navigate');
      fs.writeFileSync(fp, doc.toString({ lineWidth: 0 }));
      return json(res, 200, { ok: true });
    }
    // ---------------- what the last run found
    if (req.method === 'GET' && p === '/api/discoveries') return json(res, 200, runDiscoveries(appOf({ app: q('app') }), q('run') || undefined));
    if (req.method === 'POST' && p === '/api/discoveries/add-page') {
      // the explorer opens the page with the user's session, registers it in the Smart OR (elements + screenshot), then closes
      const b = await readBody(req);
      if (explorer.running) throw new Error('An exploration is open — stop it in Explore first');
      let page = '';
      explorer.busy = true;
      try { await explorer.start({ app: appOf(b), url: b.url, user: b.user }); page = explorer.state().page?.key ?? ''; }
      finally { explorer.busy = false; await explorer.stop(); }
      return json(res, 200, { ok: true, page });
    }
    if (req.method === 'POST' && p === '/api/discoveries/message') {
      const b = await readBody(req);
      const app = appOf(b);
      if (!b.page) throw new Error('This message appeared on a page that is not in the Smart OR yet — add the page first');
      const found = saveMessagesToPage(app, b.page, [b.message as SeenMessage]);
      let added = 0;
      if (b.addTo) {
        const rows = Number(b.rows ?? 1);
        added = addChecksToCase(app, b.addTo, b.outcome === 'success' ? 'success' : 'error', messageChecks(found, rows <= 1), found.every((f) => f.kind === 'alert'));
      }
      return json(res, 200, { ok: true, found, added });
    }
    // ---------------- history
    if (req.method === 'GET' && p === '/api/history') return json(res, 200, listHistory(appOf({ app: q('app') })));
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/history\/([a-z][a-z0-9-]*)\/(\d{8}-\d{6})$/))) {
      fs.rmSync(path.join(HISTORY_DIR, m[1], m[2]), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (m = p.match(/^\/history\/([a-z][a-z0-9-]*)\/(\d{8}-\d{6})\/(.*)$/))) {
      return serveStatic(res, path.join(HISTORY_DIR, m[1], m[2]), decodeURIComponent(m[3]));
    }
    // ---------------- branding
    if (p === '/api/branding' && req.method === 'GET') return json(res, 200, loadProfiles());
    if (p === '/api/branding' && req.method === 'PUT') { saveProfiles((await readBody(req)).profiles); return json(res, 200, { ok: true }); }
    // ---------------- git
    if (p === '/api/git' && req.method === 'GET') return json(res, 200, gitStatus());
    if (p === '/api/git/init' && req.method === 'POST') return json(res, 200, gitInit());
    if (p === '/api/git/commit' && req.method === 'POST') return json(res, 200, gitCommit((await readBody(req)).message));

    // ---------------- state
    if (req.method === 'GET' && p === '/api/state') {
      const app = appOf({ app: q('app') });
      let cfg: ReturnType<typeof loadApp> | undefined, appError: string | undefined;
      try { cfg = loadApp(app); } catch (e) { appError = (e as Error).message; }
      const { repo, error: orError } = safeRepo(app);
      const { cases, issues } = (() => { try { return readCases(app); } catch (e) { return { cases: [], issues: [{ file: '-', message: (e as Error).message }] }; } })();
      return json(res, 200, {
        app, current: currentApp(),
        apps: listApps().map((a) => { try { return { key: a, name: loadApp(a).name }; } catch { return { key: a, name: `${a} (invalid app.yml)` }; } }),
        appError, appName: cfg?.name, envs: Object.keys(cfg?.environments ?? {}), languages: cfg?.languages ?? ['en'],
        baseURLs: Object.fromEntries(Object.entries(cfg?.environments ?? {}).map(([k, v]) => [k, v.baseURL])),
        cpus: os.cpus().length,
        savedLogins: Object.keys(cfg?.users ?? {}).filter((u) => fs.existsSync(authFile(u, app))),
        settings: cfg ? { run: cfg.run ?? {}, name: cfg.name, description: cfg.description ?? '', testIdAttribute: cfg.testIdAttribute, languages: cfg.languages, defaultEnv: cfg.defaultEnv ?? '', branding: cfg.branding ?? 'default',
          environments: Object.entries(cfg.environments).map(([name, e]) => ({ name, baseURL: e.baseURL, ignoreHTTPSErrors: !!e.ignoreHTTPSErrors, startDemoApp: !!e.startDemoApp })) } : null,
        messagesDetail: Object.keys({ ...(cfg?.messages?.en ?? {}), ...(cfg?.messages?.ar ?? {}) }).map((k) => ({ key: k, en: cfg?.messages?.en?.[k] ?? '', ar: cfg?.messages?.ar?.[k] ?? '' })),
        ...(() => { const nav = readNavigation(app, repo); return { routes: nav.edges.map((e) => ({ ...e, steps: e.steps.map(({ index, ...st }) => st) })), navIssues: nav.issues }; })(),
        visuals: Object.fromEntries([...repo.keys()].map((k) => [k, fs.existsSync(path.join(orDir(app), '.visual', `${k}.png`))])),
        controls: CONTROLS, semantics: SEMANTICS.map(([k]) => k).concat(['number']),
        brandingProfiles: Object.entries(loadProfiles()).map(([k, v]) => ({ key: k, name: v.name })),
        login: cfg?.login, users: Object.keys(cfg?.users ?? {}), usersDetail: Object.entries(cfg?.users ?? {}).map(([k, u]) => ({ key: k, username: u.username, hasPassword: !!u.password })),
        messages: Object.keys(cfg?.messages?.en ?? {}),
        pages: [...repo.values()].map(pageSummary), orError, drafts: listDrafts(app),
        cases: cases.map((c) => ({ file: c.file, id: c.id, case: c.case, page: c.page, module: c.module ?? '', type: c.type ?? '', user: c.user ?? '', url: c.url ?? '', dependsOn: c.dependsOn, continueFrom: c.continueFrom ?? null, tags: c.tags, rows: c.data.length || 1, steps: c.steps.length, rowIds: c.data.map((r) => r.id ?? '').filter(Boolean), rowTitles: (c.data.length ? c.data : [{} as Record<string, unknown>]).map((r) => `${r.id ? `${r.id} · ` : ''}${r.title ?? c.case}`), saves: [...c.steps, ...Object.values(c.outcomes).flat()].filter((s) => s.action === 'save').map((s) => s.as) })),
        suites: readSuites(app),
        ...(() => {
          // workflows (raw, so a broken step can still be edited) + their problems
          const dir = flowsDir(app);
          const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.flow.yml')).sort().map((f) => {
            try { const d = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) ?? {}; return { file: f, flow: d.flow ?? f, description: d.description ?? '', module: d.module ?? '', tags: d.tags ?? [], steps: (d.steps ?? []).map((s: Record<string, unknown>) => ({ case: String(s.case ?? ''), row: s.row ?? '', as: s.as ?? '', start: s.start ?? '' })) }; }
            catch { return { file: f, flow: f, description: '', module: '', tags: [], steps: [] }; }
          }) : [];
          let flowIssues: unknown[] = [];
          try { flowIssues = readFlows(cases.filter((c) => !issues.some((i) => i.file === c.file)), app).issues; } catch (e) { flowIssues = [{ file: '-', message: (e as Error).message }]; }
          // where each case ended in the latest run that included it (helps chain cases in a workflow)
          const endsOn: Record<string, string> = {};
          for (const run of listHistory(app)) for (const t of run.tests ?? []) if (t.caseFile && t.lastPage?.page && !endsOn[t.caseFile]) endsOn[t.caseFile] = t.lastPage.page;
          return { flows: list, flowIssues, endsOn };
        })(),
        caseIssues: issues,
        actions: ACTIONS, matchers: MATCHERS, negative: Object.keys(Negative),
        targets: ['local', 'grid', 'browserstack', 'lambdatest'], projects: ['chromium'],
        running: current && !current.done ? { id: current.id, label: current.label, kind: current.kind } : null,
        lastLog: current?.log.slice(-400) ?? [], history,
        report: fs.existsSync(path.join(REPORT_DIR, 'index.html')),
      });
    }
    if (req.method === 'POST' && p === '/api/apps/select') {
      setCurrentApp((await readBody(req)).app);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/tests') {
      return json(res, 200, await listTests(envVars({ app: q('app'), env: q('env'), locale: q('locale') })));
    }

    // ---------------- run
    if (req.method === 'POST' && p === '/api/run') {
      const s: RunSettings = await readBody(req);
      const args = [PW_CLI, 'test'];
      if (s.project) args.push(`--project=${s.project}`);
      if (s.headed) args.push('--headed');
      // a visible browser is for watching: one at a time unless asked otherwise
      const workers = s.workers || (s.headed ? 1 : undefined);
      if (workers) args.push(`--workers=${workers}`);
      if (s.retries !== undefined && s.retries !== null) args.push(`--retries=${s.retries}`);
      if (s.grep) args.push(`--grep=${s.grep}`);
      const env = envVars(s);
      await new Promise((r) => spawn(process.execPath, [TSX_CLI, 'scripts/generate-or-types.ts'], { cwd: ROOT, env: childEnv() }).on('close', r));
      const proj = (() => { try { return loadApp(env.APP).run ?? {}; } catch { return {}; } })();
      const job = startJob('test', `Run ${s.label ?? 'all tests'} · ${env.APP} · ${s.env ?? 'default env'} · ${s.locale ?? 'en'} · ${s.target ?? 'local'} · ${workers ?? proj.workers ?? 2} browser(s) at a time`, args, env);
      return json(res, 200, { id: job.job.id });
    }
    // ---------------- suites
    if (req.method === 'PUT' && p === '/api/suites') {
      const body = await readBody(req);
      const app = appOf(body);
      for (const s of body.suites ?? []) if (!/^[a-z][a-z0-9-]*$/.test(s.name)) throw new Error(`Suite name "${s.name}": lowercase letters, digits and "-"`);
      writeSuites(app, body.suites ?? []);
      return json(res, 200, { ok: true });
    }
    // ---------------- detect the page a test ended on (re-runs that one test and harvests its last page)
    if (req.method === 'POST' && p === '/api/detect-last') {
      const s = await readBody(req);
      const key = String(s.pageKey || '1');
      if (key !== '1' && !/^[a-z][a-zA-Z0-9]*$/.test(key)) throw new Error('Page name: start with a lowercase letter, letters and digits only (e.g. checkout)');
      const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const args = [PW_CLI, 'test', '--project=chromium', '--workers=1', `--grep=${reEsc(s.title)}(?: |$)`];
      const job = startJob('test', `Detect the page "${s.title}" ends on`, args, { ...envVars(s), DETECT_LAST: key });
      return json(res, 200, { id: job.job.id });
    }
    if (req.method === 'POST' && p === '/api/stop') {
      if (current && !current.done) current.proc?.kill();
      return json(res, 200, { ok: true });
    }

    // ---------------- setup wizard
    if (req.method === 'POST' && (m = p.match(/^\/api\/wizard\/(check|analyzeLogin|create|bootstrap)$/))) {
      const body = await readBody(req);
      const env: Record<string, string> = {};
      if (m[1] === 'bootstrap') { env.APP = body.key; if (body.envName) env.ENV = body.envName; }
      const job = await wizard(m[1], body, env);
      return json(res, 200, job.result ?? { ok: false, error: job.log.slice(-5).join('\n') || 'Wizard step failed' });
    }

    // ---------------- pages & elements
    if ((m = p.match(/^\/api\/pages\/([a-zA-Z0-9]+)$/)) && req.method === 'PUT') {
      const body = await readBody(req);
      savePage(appOf(body), m[1], body);
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/pages\/([a-zA-Z0-9]+)\/open$/)) && req.method === 'POST') {
      const s = await readBody(req);
      startJob('open', `Open page "${m[1]}" in browser`, [TSX_CLI, 'scripts/open-page.ts', m[1]], envVars(s));
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/pages\/([a-zA-Z0-9]+)\/elements\/([a-zA-Z0-9]+)$/))) {
      const body = await readBody(req);
      const app = appOf({ app: body.app ?? q('app') });
      if (req.method === 'PATCH') {
        if (body.meta) { setElementMeta(app, m[1], m[2], body.meta); return json(res, 200, { ok: true }); }
        return json(res, 200, { ok: true, ...renameElement(app, m[1], m[2], body.to) });
      }
      if (req.method === 'DELETE') { deleteElement(app, m[1], m[2]); return json(res, 200, { ok: true }); }
      if (req.method === 'GET') return json(res, 200, { usage: elementUsage(app, m[1], m[2]) });
    }
    if ((m = p.match(/^\/api\/pages\/([a-zA-Z0-9]+)\/elements\/([a-zA-Z0-9]+)\/check$/)) && req.method === 'POST') {
      const s = await readBody(req);
      const job = await startJob('check', `Check element ${m[1]}.${m[2]}`, [TSX_CLI, 'scripts/check-element.ts', m[1], m[2], JSON.stringify(s.params ?? {})], envVars(s));
      return json(res, 200, job.result ?? { ok: false, error: job.log.slice(-3).join('\n') });
    }
    if (p === '/api/harvest' && req.method === 'POST') {
      const b = await readBody(req);
      if (!/^[a-z][a-zA-Z0-9]*$/.test(b.page ?? '')) throw new Error('Page key must be camelCase, e.g. patientForm');
      startJob('harvest', `Harvest ${b.path} → or/drafts/${b.page}.page.yml`,
        [TSX_CLI, 'scripts/or-harvester.ts', b.path || '/', b.page, ...(b.auth && b.auth !== 'none' ? ['--auth', b.auth] : []), ...(b.locale === 'ar' ? ['--lang', 'ar'] : [])], envVars(b));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/drafts/promote' && req.method === 'POST') {
      const b = await readBody(req);
      promoteDraft(appOf(b), b.file);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/drafts' && req.method === 'DELETE') {
      const ddir = path.join(orDir(appOf({ app: q('app') })), 'drafts'), f = path.basename(q('file') ?? '');
      for (const x of [f, f.replace(/\.page\.yml$/, '.visual.png'), f.replace(/\.page\.yml$/, '.visual.json')]) fs.rmSync(path.join(ddir, x), { force: true });
      return json(res, 200, { ok: true });
    }

    // ---------------- cases
    if ((m = p.match(/^\/api\/cases\/([\w.-]+)$/))) {
      if (req.method === 'GET') return json(res, 200, caseDetail(appOf({ app: q('app') }), m[1]));
      if (req.method === 'PUT') { const b = await readBody(req); return json(res, 200, { ok: true, ...saveCase(appOf(b), m[1], b) }); }
      if (req.method === 'DELETE') { fs.rmSync(path.join(casesDir(appOf({ app: q('app') })), path.basename(m[1])), { force: true }); return json(res, 200, { ok: true }); }
    }

    // ---------------- 🧭 explore (live browser session inside the panel)
    if (p.startsWith('/api/explore')) {
      const guard = async (fn: () => Promise<unknown>) => {
        if (explorer.busy) throw new Error('Still working on the previous step…');
        explorer.busy = true; explorer.error = undefined;
        try { await fn(); } catch (e) { explorer.error = (e as Error).message; throw e; } finally { explorer.busy = false; }
      };
      if (p === '/api/explore' && req.method === 'GET') return json(res, 200, explorer.state());
      const b = req.method === 'POST' ? await readBody(req) : {};
      if (p === '/api/explore/start') { await guard(() => explorer.start({ app: appOf(b), env: b.env, url: b.url, user: b.user, headed: !!b.headed, after: b.after })); return json(res, 200, explorer.state()); }
      if (p === '/api/explore/act') { await guard(() => explorer.act({ id: b.id, element: b.element, option: b.option, value: b.value })); return json(res, 200, explorer.state()); }
      if (p === '/api/explore/undo') { await guard(() => explorer.undo()); return json(res, 200, explorer.state()); }
      if (p === '/api/explore/rename') { explorer.rename(b.from, b.to); return json(res, 200, explorer.state()); }
      if (p === '/api/explore/save') { const r = explorer.save(b.name, b.module); return json(res, 200, { ok: true, ...r }); }
      if (p === '/api/explore/stop') { await explorer.stop(); return json(res, 200, explorer.state()); }
    }

    // ---------------- workflows
    if ((m = p.match(/^\/api\/flows\/([\w.-]+)$/))) {
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const app = appOf(b);
        if (!b.flow?.trim()) throw new Error('Give the workflow a name');
        const file = writeFlow(app, m[1], b);
        const { cases } = readCases(app);
        return json(res, 200, { ok: true, file, issues: readFlows(cases, app).issues.filter((i) => i.file === file) });
      }
      if (req.method === 'DELETE') { fs.rmSync(path.join(flowsDir(appOf({ app: q('app') })), path.basename(m[1])), { force: true }); return json(res, 200, { ok: true }); }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Control Panel → ${link}\n`);
  if (!process.env.CI && process.env.PANEL_OPEN !== 'false') {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
    const c = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  }
});
