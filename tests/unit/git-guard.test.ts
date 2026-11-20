import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSecrets, isSecretPath, parsePorcelainZ, planCommit, type GitChange } from '../../panel/git-guard';

test('parsePorcelainZ reads statuses, spaces and renames', () => {
  const out = '?? apps/demo/cases/a b.case.yml\0 M panel/server.ts\0R  apps/demo/or/new.page.yml\0apps/demo/or/old.page.yml\0D  branding/old.yml\0';
  assert.deepEqual(parsePorcelainZ(out), [
    { status: '??', file: 'apps/demo/cases/a b.case.yml' },
    { status: ' M', file: 'panel/server.ts' },
    { status: 'R ', file: 'apps/demo/or/new.page.yml', from: 'apps/demo/or/old.page.yml' },
    { status: 'D ', file: 'branding/old.yml' },
  ]);
  assert.deepEqual(parsePorcelainZ(''), []);
});

test('secret file names are recognised', () => {
  for (const f of ['apps/demo/secrets.yml', 'apps/x/secrets.YAML', '.env', 'apps/a/.env.local', '.auth/demo/standard.json', 'branding/cert.pem', 'apps/a/id_rsa', '.npmrc', 'apps/a/credentials.json']) {
    assert.ok(isSecretPath(f), f);
  }
  for (const f of ['apps/demo/app.yml', 'apps/demo/cases/login.case.yml', 'apps/demo/or/environment.page.yml', 'branding/profiles.yml']) {
    assert.ok(!isSecretPath(f), f);
  }
});

test('findSecrets spots keys and tokens anywhere', () => {
  assert.deepEqual(findSecrets('x.yml', '-----BEGIN RSA PRIVATE KEY-----\nabc'), ['private key']);
  assert.deepEqual(findSecrets('x.yml', 'key: AKIAABCDEFGHIJKLMNOP'), ['AWS access key']); // gitleaks:allow (fake test value)
  assert.deepEqual(findSecrets('x.yml', `t: ghp_${'a'.repeat(36)}`), ['GitHub token']);
  assert.deepEqual(findSecrets('x.yml', 'BROWSERSTACK_ACCESS_KEY=abcdefABCDEF1234'), ['cloud browser key']); // gitleaks:allow (fake test value)
});

test('findSecrets flags literal passwords in app.yml but accepts placeholders', () => {
  const app = 'apps/demo/app.yml';
  assert.deepEqual(findSecrets(app, 'users:\n  standard:\n    username: u\n    password: hunter22\n'), ['literal password in app.yml']);
  assert.deepEqual(findSecrets(app, 'users:\n  admin:\n    password: "S3cret!"  # temp\n'), ['literal password in app.yml']);
  for (const ok of ['password: ${UAT_PASSWORD}', 'password: ""', 'password:', 'password: ~', 'password: null', 'password: "{{user.x.password}}"']) {
    assert.deepEqual(findSecrets(app, `users:\n  a:\n    ${ok}\n`), [], ok);
  }
});

test('findSecrets leaves negative test data in cases alone, but not a real password', () => {
  const kase = 'apps/demo/cases/login-rejected.case.yml';
  const text = 'data:\n  - id: TC-101\n    password: wrongpass1\n  - id: TC-102\n    password: "{{faker.internet.password}}"\n';
  assert.deepEqual(findSecrets(kase, text), []);
  assert.deepEqual(findSecrets(kase, text, ['wrongpass1']), ['a password from secrets.yml']);
  // very short known values are ignored to avoid noise
  assert.deepEqual(findSecrets(kase, 'value: abc', ['abc']), []);
});

test('planCommit commits project files, skips code, blocks secrets', () => {
  const files: Record<string, string> = {
    'apps/demo/cases/new.case.yml': 'case: New\n',
    'apps/demo/app.yml': 'users:\n  a:\n    password: hunter22\n',
    'branding/profiles.yml': 'default:\n  name: Default\n',
    'panel/server.ts': 'code',
  };
  const changes: GitChange[] = [
    { status: '??', file: 'apps/demo/cases/new.case.yml' },
    { status: ' M', file: 'apps/demo/app.yml' },
    { status: ' M', file: 'branding/profiles.yml' },
    { status: ' M', file: 'panel/server.ts' },
    { status: '??', file: 'apps/demo/secrets.yml' },
    { status: ' D', file: 'apps/demo/cases/old.case.yml' },
    { status: 'R ', file: 'apps/demo/x.yml', from: 'tests/x.yml' },
  ];
  const plan = planCommit(changes, (f) => files[f]);
  assert.deepEqual(plan.commit.map((c) => c.file), ['apps/demo/cases/new.case.yml', 'branding/profiles.yml', 'apps/demo/cases/old.case.yml']);
  assert.deepEqual(plan.skipped.map((s) => s.change.file), ['panel/server.ts', 'apps/demo/x.yml']);
  assert.deepEqual(plan.blocked.map((b) => b.change.file), ['apps/demo/app.yml', 'apps/demo/secrets.yml']);
  assert.match(plan.blocked[0].reason, /literal password/);
});

test('planCommit reads Windows paths the same way', () => {
  const plan = planCommit([{ status: '??', file: 'apps\\demo\\secrets.yml' }], () => '');
  assert.equal(plan.blocked.length, 1);
});
