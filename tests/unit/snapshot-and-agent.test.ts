import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { toSnapshot, withoutSecrets, writeSnapshot, type ProjectSnapshot } from '../../src/core/snapshot';
import { resolveSecrets, resolveSecret } from '../../agent/secrets';
import { runnerArgs, runnerEnv } from '../../agent/agent';

test('snapshots never carry passwords', () => {
  const app = { users: { a: { username: 'u', password: 'p' } }, environments: { uat: { baseURL: 'https://x', httpCredentials: { username: 'b', password: 'q' } } } };
  const clean = withoutSecrets(app) as typeof app;
  assert.equal('password' in clean.users.a, false);
  assert.equal('password' in clean.environments.uat.httpCredentials, false);
  assert.equal(app.users.a.password, 'p', 'the original is not modified');
});

test('every bundled project round-trips through a snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-snap-'));
  try {
    for (const app of ['demo', 'portal', 'txdemo', 'widget']) {
      const snap = toSnapshot(app);
      const dir = writeSnapshot(snap, root, { as: `copy-${app}` });
      const again = YAML.parse(fs.readFileSync(path.join(dir, 'app.yml'), 'utf8'));
      assert.deepEqual(again, snap.app, `${app}: app.yml`);
      for (const [key, page] of Object.entries(snap.pages)) {
        assert.deepEqual(YAML.parse(fs.readFileSync(path.join(dir, 'or', `${key}.page.yml`), 'utf8')), page, `${app}: page ${key}`);
      }
      assert.equal(Object.keys(snap.cases).length, fs.readdirSync(path.join(dir, 'cases')).length, `${app}: cases`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a hostile snapshot cannot write outside the project folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-snap-'));
  const base: ProjectSnapshot = { contract: 'atimtha.project/1', key: 'evil', app: { name: 'x', environments: { e: { baseURL: 'https://x' } } }, messages: {}, pages: {}, cases: {}, flows: {}, navigation: { edges: [] }, suites: {} };
  try {
    assert.throws(() => writeSnapshot({ ...base, key: '../escape' }, root), /Invalid project name/);
    assert.throws(() => writeSnapshot({ ...base, cases: { '../../x': { case: 'x' } } }, root, { overwrite: true }), /Invalid file name/);
    assert.throws(() => writeSnapshot({ ...base, pages: { 'a/b': { page: 'a/b', elements: {} } } }, root, { overwrite: true }), /Invalid page name/);
    assert.throws(() => writeSnapshot({ ...base, pages: { login: { page: 'other', elements: {} } } }, root, { overwrite: true }), /says it is/);
    assert.throws(() => writeSnapshot({ ...base, contract: 'atimtha.project/9' as never }, root), /Unsupported snapshot contract/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secret references resolve from the agent environment or a secrets folder only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-secrets-'));
  process.env.ATIMTHA_TEST_SECRET = 's3cret';
  process.env.ATIMTHA_SECRETS_DIR = dir;
  fs.writeFileSync(path.join(dir, 'uat-basic'), 'basic-pw\n');
  try {
    assert.equal(resolveSecret('vault:env/ATIMTHA_TEST_SECRET'), 's3cret');
    assert.equal(resolveSecret('vault:file/uat-basic'), 'basic-pw');
    assert.equal(resolveSecret('vault:file/../etc/passwd'), undefined);
    assert.equal(resolveSecret('vault:unknown/x'), undefined);
    const r = resolveSecrets({
      'users.standard.password': 'vault:env/ATIMTHA_TEST_SECRET',
      'environments.uat.httpCredentials.password': 'vault:file/uat-basic',
      'users.admin.password': 'vault:env/NOT_SET_ANYWHERE',
    });
    assert.deepEqual(r.secrets.users, { standard: { password: 's3cret' } });
    assert.deepEqual(r.secrets.environments, { uat: { httpCredentials: { password: 'basic-pw' } } });
    assert.deepEqual(r.missing, ['users.admin.password']);
  } finally {
    delete process.env.ATIMTHA_TEST_SECRET;
    delete process.env.ATIMTHA_SECRETS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const job = (over: Record<string, unknown> = {}) => ({
  contract: 'atimtha.job/1', jobId: 'j', executionId: '0d3f6a2c-1111-2222-3333-444455556666', organizationId: 'o', engine: 'web',
  project: {} as ProjectSnapshot, environment: { key: 'uat', baseURL: 'https://uat.example.com' },
  selection: { cases: ['login', 'bad;rm -rf /'], rows: ['TC-001'], tags: ['@smoke', 'reg ression'], suite: 'smoke', grep: 'Login (valid)' },
  settings: { locale: 'ar', workers: 99, retries: 1, healing: 'flag', testTimeoutSeconds: 60, seed: 42 },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
}) as never;

test('the runner environment is built from validated values only', () => {
  const e = runnerEnv(job(), 'job-0d3f6a2c1111', '/tmp/s.json');
  assert.equal(e.APP, 'job-0d3f6a2c1111');
  assert.equal(e.BASE_URL, 'https://uat.example.com');
  assert.equal(e.LOCALE, 'ar');
  assert.equal(e.HEALING, 'flag');
  assert.equal(e.SEED, '42');
  assert.equal(e.WORKERS, undefined, 'out-of-range workers are dropped');
  assert.equal(e.ONLY_CASES, 'login', 'a value that is not a plain name is dropped');
  assert.equal(e.ONLY_ROWS, 'TC-001');
  assert.equal(e.SUITE, 'smoke');
  assert.equal(runnerEnv(job({ settings: { healing: '$(evil)' } }), 'k', 's').HEALING, 'pass');
});

test('runner arguments: fixed runner and reporters, grep escaped', () => {
  const args = runnerArgs(job());
  assert.ok(args[0].endsWith(path.join('@playwright', 'test', 'cli.js')));
  assert.equal(args[1], 'test');
  assert.equal(args[2], '--reporter=list,./reporters/agent-reporter.ts,./reporters/smart-reporter.ts');
  assert.equal(args[3], '--grep=(@smoke).*Login \\(valid\\)');
  assert.equal(args.length, 4);
});
