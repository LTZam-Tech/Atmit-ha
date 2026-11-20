/**
 * Offline drafts (ADR-0007): work on a platform project locally, then send the edits for review.
 *
 *   npm run drafts -- pull <projectId> [--as <key>]        platform project → apps/<key>/ (+ base versions)
 *   npm run drafts -- status <app>                          which cases, pages and workflows changed since the pull
 *   npm run drafts -- push <app> "<title>"                  changed / new cases, pages and workflows → a change set (source: local)
 *
 * Platform and sign-in: ATIMTHA_PLATFORM_URL, ATIMTHA_ORG (organisation key), and ATIMTHA_TOKEN (OIDC access token)
 * or, against a development platform only, ATIMTHA_DEV_USER (email).
 * Edit cases and pages (or/*.page.yml) in the Control Panel or by hand meanwhile; tests run locally as usual, even without the platform.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { APPS_DIR, appDir } from '../src/core/app';
import { writeSnapshot, type ProjectSnapshot } from '../src/core/snapshot';

const BASE_FILE = '.atimtha-base.json';

interface Base {
  platform: string;
  organization: string;
  projectId: string;
  pulledAt: string;
  /** case key → version and content hash at pull time */
  cases: Record<string, { version: number; sha256: string }>;
  /** page key → version and content hash at pull time (absent in bases pulled before pages could be reviewed) */
  pages?: Record<string, { version: number; sha256: string }>;
  /** workflow key → version and content hash at pull time */
  flows?: Record<string, { version: number; sha256: string }>;
}

export type AssetType = 'test_case' | 'page' | 'workflow';
export interface Change { assetType: AssetType; key: string; baseVersion: number | null; content: unknown }

const env = {
  platform: (process.env.ATIMTHA_PLATFORM_URL ?? '').replace(/\/+$/, ''),
  org: process.env.ATIMTHA_ORG ?? '',
  token: process.env.ATIMTHA_TOKEN,
  devUser: process.env.ATIMTHA_DEV_USER,
};

/** stable hash of a case: key order does not matter */
export function caseHash(content: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(sort(content))).digest('hex');
}

/** cases edited or added locally since the pull */
export function changedCases(base: Base, local: Record<string, unknown>): { key: string; baseVersion: number | null; content: unknown }[] {
  return Object.entries(local)
    .filter(([key, content]) => base.cases[key]?.sha256 !== caseHash(content))
    .map(([key, content]) => ({ key, baseVersion: base.cases[key]?.version ?? null, content }));
}

/** cases and pages edited or added locally since the pull; pages only when the base knows them */
export function changes(base: Base, cases: Record<string, unknown>, pages: Record<string, unknown>, flows: Record<string, unknown> = {}): Change[] {
  const out: Change[] = changedCases(base, cases).map((c) => ({ assetType: 'test_case', ...c }));
  if (base.pages) {
    for (const [key, content] of Object.entries(pages)) {
      if (base.pages[key]?.sha256 === caseHash(content)) continue;
      out.push({ assetType: 'page', key, baseVersion: base.pages[key]?.version ?? null, content });
    }
  }
  if (base.flows) {
    for (const [key, content] of Object.entries(flows)) {
      if (base.flows[key]?.sha256 === caseHash(content)) continue;
      out.push({ assetType: 'workflow', key, baseVersion: base.flows[key]?.version ?? null, content });
    }
  }
  return out;
}

function headers(): Record<string, string> {
  if (!env.platform || !env.org) throw new Error('Set ATIMTHA_PLATFORM_URL and ATIMTHA_ORG.');
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'X-Atimtha-Organization': env.org };
  if (env.token) h.Authorization = `Bearer ${env.token}`;
  else if (env.devUser) h['X-Dev-User'] = env.devUser;
  else throw new Error('Set ATIMTHA_TOKEN (or ATIMTHA_DEV_USER for a development platform).');
  return h;
}

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.platform}/api/v1${route}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status}\n${text.slice(0, 2000)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

function readLocalCases(app: string): Record<string, unknown> {
  const dir = path.join(appDir(app), 'cases');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.case.yml')).sort()
    .map((f) => [f.slice(0, -'.case.yml'.length), YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
}

function readLocalPages(app: string): Record<string, unknown> {
  const dir = path.join(appDir(app), 'or');
  if (!fs.existsSync(dir)) return {};
  const pages: Record<string, unknown> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.page.yml')).sort()) {
    const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { page?: unknown } | null;
    if (raw && typeof raw.page === 'string') pages[raw.page] = raw;
  }
  return pages;
}

function readLocalFlows(app: string): Record<string, unknown> {
  const dir = path.join(appDir(app), 'flows');
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.flow.yml')).sort()
    .map((f) => [f.slice(0, -'.flow.yml'.length), YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
}

function readBase(app: string): Base {
  const f = path.join(appDir(app), BASE_FILE);
  if (!fs.existsSync(f)) throw new Error(`apps/${app} was not pulled from the platform (no ${BASE_FILE}). Use: drafts pull <projectId>`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as Base;
}

async function pull(projectId: string, as?: string) {
  const snap = await call<ProjectSnapshot>('GET', `/projects/${encodeURIComponent(projectId)}/snapshot`);
  const key = as ?? snap.key;
  const dir = writeSnapshot(snap, APPS_DIR, { as: key, overwrite: true });
  const base: Base = {
    platform: env.platform, organization: env.org, projectId, pulledAt: new Date().toISOString(),
    cases: Object.fromEntries(Object.entries(snap.cases).map(([k, c]) => [k, { version: snap.versions?.cases?.[k] ?? 1, sha256: caseHash(c) }])),
    pages: Object.fromEntries(Object.entries(snap.pages).map(([k, p]) => [k, { version: snap.versions?.pages?.[k] ?? 1, sha256: caseHash(p) }])),
    flows: Object.fromEntries(Object.entries(snap.flows ?? {}).map(([k, f]) => [k, { version: snap.versions?.flows?.[k] ?? 1, sha256: caseHash(f) }])),
  };
  fs.writeFileSync(path.join(dir, BASE_FILE), JSON.stringify(base, null, 1));
  console.log(`Pulled ${snap.key} → apps/${key} (${Object.keys(snap.cases).length} cases, ${Object.keys(snap.pages).length} pages). Add passwords to apps/${key}/secrets.yml to run tests.`);
}

function status(app: string) {
  const base = readBase(app);
  const list = changes(base, readLocalCases(app), readLocalPages(app), readLocalFlows(app));
  if (!base.pages) console.log('(pulled before pages could be reviewed: pull again to send page edits too)');
  if (!list.length) return console.log('No local changes.');
  for (const c of list) console.log(`${c.baseVersion === null ? 'new     ' : `changed (from v${c.baseVersion})`}  ${c.assetType === 'page' ? 'page ' : c.assetType === 'workflow' ? 'flow ' : 'case '} ${c.key}`);
}

async function push(app: string, title: string) {
  const base = readBase(app);
  const list = changes(base, readLocalCases(app), readLocalPages(app), readLocalFlows(app));
  if (!list.length) return console.log('No local changes to send.');
  const set = await call<{ id: string; items: number }>('POST', `/projects/${encodeURIComponent(base.projectId)}/change-sets`, {
    title, source: 'local', items: list.map((c) => ({ assetType: c.assetType, key: c.key, baseVersion: c.baseVersion, content: c.content })),
  });
  const pages = list.filter((c) => c.assetType === 'page').length;
  const flows = list.filter((c) => c.assetType === 'workflow').length;
  console.log(`Sent ${list.length - pages - flows} case(s), ${pages} page(s) and ${flows} workflow(s) for review: change set ${set.id}. After approval, pull again to continue on the new versions.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const run = async () => {
    if (cmd === 'pull' && rest[0]) { const as = flag('--as'); return pull(rest[0], as); }
    if (cmd === 'status' && rest[0]) return status(rest[0]);
    if (cmd === 'push' && rest[0] && rest[1]) return push(rest[0], rest[1]);
    console.error('usage: drafts pull <projectId> [--as key] | status <app> | push <app> "<title>"');
    process.exit(2);
  };
  run().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
