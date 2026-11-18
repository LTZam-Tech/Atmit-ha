import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHeal, healingPolicy, healingVerdict, healsOf, type HealEvent } from '../../src/core/healing';

const heal = (over: Partial<HealEvent> = {}): HealEvent => ({
  kind: 'fallback-locator', target: 'login.submit', purpose: 'action',
  original: 'primary locator [testid=login-button] matched no element', healedBy: 'fallback #1 [id=login-button]', fix: 'Update or/login.page.yml',
  ...over,
});

test('healingPolicy: env var wins, then app.yml, then "pass"; unknown values fall back to "pass"', () => {
  const saved = process.env.HEALING;
  try {
    delete process.env.HEALING;
    assert.equal(healingPolicy(), 'pass');
    assert.equal(healingPolicy('flag'), 'flag');
    process.env.HEALING = 'OFF';
    assert.equal(healingPolicy('flag'), 'off');
    process.env.HEALING = 'sometimes';
    assert.equal(healingPolicy('flag'), 'pass');
  } finally {
    if (saved === undefined) delete process.env.HEALING; else process.env.HEALING = saved;
  }
});

test('no heals → no verdict under any policy', () => {
  for (const p of ['pass', 'flag', 'off'] as const) assert.equal(healingVerdict([], p), undefined);
});

test('"pass" accepts heals during actions and navigation', () => {
  assert.equal(healingVerdict([heal(), heal({ kind: 'navigation-route', purpose: 'navigation', target: 'cart' })], 'pass'), undefined);
});

test('"pass" fails a test whose check passed through a substitute element, keeping the original failure', () => {
  const v = healingVerdict([heal(), heal({ target: 'cart.total', purpose: 'check', original: 'primary locator [testid=total] matched 3 elements (ambiguous)' })], 'pass');
  assert.ok(v);
  assert.match(v!, /^\[Healing\]/);
  assert.match(v!, /cart\.total/);
  assert.match(v!, /matched 3 elements \(ambiguous\)/);
  assert.ok(!v!.includes('login.submit'), 'action heals are not listed as blocking under "pass"');
});

test('"flag" fails any healed test and lists every heal', () => {
  const v = healingVerdict([heal(), heal({ kind: 'ready-element', purpose: 'navigation', target: 'inventory' })], 'flag');
  assert.ok(v);
  assert.match(v!, /login\.submit/);
  assert.match(v!, /inventory/);
  assert.match(v!, /policy is "flag"/);
});

test('healsOf reads structured healing annotations and ignores others or broken ones', () => {
  const h = heal();
  const ann = [
    { type: 'or-healed', description: 'legacy text' },
    { type: 'healing', description: JSON.stringify(h) },
    { type: 'healing', description: '{broken' },
    { type: 'context', description: 'app=demo' },
  ];
  assert.deepEqual(healsOf(ann), [h]);
});

test('describeHeal names the target, original failure, substitute and the check', () => {
  const d = describeHeal(heal({ purpose: 'check' }));
  assert.match(d, /^login\.submit: primary locator .* → healed by fallback #1 .*\(during a check\)\. Update or\/login\.page\.yml$/);
});
