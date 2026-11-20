/**
 * Project snapshot — one JSON document holding a whole 0.1.0 project (ADR-0014, contracts/project-snapshot.schema.json).
 *
 *   toSnapshot(app)              apps/<app>/*.yml → snapshot (passwords removed: they live in the secrets manager)
 *   writeSnapshot(s, dir, opts)  snapshot → <dir>/<key>/*.yml, exactly the 0.1.0 layout, so the engine runs unchanged
 *
 * Used by the platform import (scripts/snapshot.ts export) and by execution agents (materialising a job).
 * The agent writes files from data it received over the network, so every name that becomes a file name is
 * checked against a strict pattern: nothing can write outside the project folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { appDir } from './app';

export const SNAPSHOT_CONTRACT = 'atimtha.project/1';

type Raw = Record<string, unknown>;

export interface ProjectSnapshot {
  contract: typeof SNAPSHOT_CONTRACT;
  /** the project key (0.1.0 folder name) */
  key: string;
  /** platform exports only: version of each page / case / workflow — the base of offline drafts (ADR-0007) */
  versions?: { pages?: Record<string, number>; cases?: Record<string, number>; flows?: Record<string, number> };
  /** the project's report branding profile (platform only; the logo is a data URI) */
  branding?: Record<string, unknown> | null;
  /** app.yml as written, without passwords */
  app: Raw;
  /** messages.yml: locale → key → text */
  messages: Record<string, Record<string, string>>;
  /** page key → or/<page>.page.yml */
  pages: Record<string, Raw>;
  /** case id (file name without .case.yml) → case file */
  cases: Record<string, Raw>;
  /** workflow id → flows/<id>.flow.yml */
  flows: Record<string, Raw>;
  /** navigation.yml */
  navigation: { edges: unknown[] };
  /** suites.yml */
  suites: Raw;
}

export const KEY_PATTERNS = {
  project: /^[a-z][a-z0-9-]{0,62}$/,
  page: /^[a-z][a-zA-Z0-9]{0,99}$/,
  file: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/,
} as const;

function assertName(kind: keyof typeof KEY_PATTERNS, name: string) {
  if (!KEY_PATTERNS[kind].test(name) || name.includes('..')) throw new Error(`Invalid ${kind} name in snapshot: "${name}"`);
}

const readYaml = (file: string): Raw => (fs.existsSync(file) ? (YAML.parse(fs.readFileSync(file, 'utf8')) as Raw) ?? {} : {});

const readFolder = (dir: string, suffix: string): Record<string, Raw> => {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(
    fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => [f.slice(0, -suffix.length), readYaml(path.join(dir, f))]),
  );
};

/** remove passwords: users[*].password and environments[*].httpCredentials.password */
export function withoutSecrets(app: Raw): Raw {
  const copy = structuredClone(app);
  const users = copy.users as Record<string, Raw> | undefined;
  for (const u of Object.values(users ?? {})) delete u.password;
  const envs = copy.environments as Record<string, Raw> | undefined;
  for (const e of Object.values(envs ?? {})) {
    const cred = e.httpCredentials as Raw | undefined;
    if (cred) delete cred.password;
  }
  return copy;
}

export function toSnapshot(app: string): ProjectSnapshot {
  assertName('project', app);
  const dir = appDir(app);
  if (!fs.existsSync(path.join(dir, 'app.yml'))) throw new Error(`apps/${app}/app.yml not found`);
  const pages: Record<string, Raw> = {};
  for (const raw of Object.values(readFolder(path.join(dir, 'or'), '.page.yml'))) {
    const key = String(raw.page ?? '');
    assertName('page', key);
    pages[key] = raw;
  }
  const nav = readYaml(path.join(dir, 'navigation.yml'));
  return {
    contract: SNAPSHOT_CONTRACT,
    key: app,
    app: withoutSecrets(readYaml(path.join(dir, 'app.yml'))),
    messages: readYaml(path.join(dir, 'messages.yml')) as ProjectSnapshot['messages'],
    pages,
    cases: readFolder(path.join(dir, 'cases'), '.case.yml'),
    flows: readFolder(path.join(dir, 'flows'), '.flow.yml'),
    navigation: { edges: Array.isArray(nav.edges) ? nav.edges : [] },
    suites: readYaml(path.join(dir, 'suites.yml')),
  };
}

export interface WriteOptions {
  /** write under this key instead of the snapshot's (agents use a per-job key) */
  as?: string;
  /** secrets.yml content resolved by the agent: users.<key>.password, environments.<key>.httpCredentials */
  secrets?: Raw;
  /** replace an existing folder */
  overwrite?: boolean;
}

/** Writes the snapshot as <root>/<key>/ in the 0.1.0 layout; returns the folder. */
export function writeSnapshot(s: ProjectSnapshot, root: string, opts: WriteOptions = {}): string {
  if (s.contract !== SNAPSHOT_CONTRACT) throw new Error(`Unsupported snapshot contract "${s.contract}" (expected ${SNAPSHOT_CONTRACT})`);
  const key = opts.as ?? s.key;
  assertName('project', key);
  const dir = path.join(root, key);
  if (fs.existsSync(dir)) {
    if (!opts.overwrite) throw new Error(`${dir} already exists`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const write = (rel: string, data: unknown, header = '') => {
    const file = path.join(dir, rel);
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) throw new Error(`Refusing to write outside the project: ${rel}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, header + YAML.stringify(data, { lineWidth: 0 }));
  };

  write('app.yml', s.app);
  if (Object.keys(s.messages ?? {}).length) write('messages.yml', s.messages);
  for (const [key, page] of Object.entries(s.pages ?? {})) {
    assertName('page', key);
    if (page.page !== key) throw new Error(`Page "${key}" says it is "${String(page.page)}"`);
    write(`or/${key}.page.yml`, page);
  }
  for (const [id, c] of Object.entries(s.cases ?? {})) { assertName('file', id); write(`cases/${id}.case.yml`, c); }
  for (const [id, f] of Object.entries(s.flows ?? {})) { assertName('file', id); write(`flows/${id}.flow.yml`, f); }
  if (s.navigation?.edges?.length) write('navigation.yml', s.navigation);
  if (s.suites && Object.keys(s.suites).length) write('suites.yml', s.suites);
  write('secrets.yml', opts.secrets ?? { users: {} }, '# written by the execution agent from secret references — deleted after the job\n');
  return dir;
}
