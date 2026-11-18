import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRows, rowTags } from '../../src/core/cases/plan';
import type { CaseDef } from '../../src/core/cases/model';
import { pagePath, withBaseQuery, sameAddress } from '../../src/utils/url';

const kase = (id: string, over: Partial<CaseDef> = {}): CaseDef => ({
  file: `${id}.case.yml`, id, case: id, dependsOn: [], tags: [], steps: [], outcomes: {}, data: [], ...over,
});

test('no suite selects every row of every case', () => {
  const sel = selectRows([kase('a', { data: [{ id: '1' }, { id: '2' }] }), kase('b')]);
  assert.deepEqual([...sel.get('a')!], [0, 1]);
  assert.deepEqual([...sel.get('b')!], [0]);
});

test('a tag suite selects only the matching rows, case and row tags included', () => {
  const c = kase('login', { tags: ['@login'], data: [{ id: 'TC-1', type: 'positive' }, { id: 'TC-2', type: 'negative', tags: ['smoke'] }] });
  assert.deepEqual(rowTags(c, c.data[1]), ['@login', '@negative', '@smoke']);
  const sel = selectRows([c], { name: 'smoke', tags: ['@smoke'] });
  assert.deepEqual([...sel.get('login')!], [1]);
});

test('a selected case brings the cases it depends on, transitively', () => {
  const cases = [kase('register'), kase('login', { dependsOn: ['register'] }), kase('order', { dependsOn: ['login'] }), kase('other')];
  const sel = selectRows(cases, { name: 'orders', cases: ['order'] });
  assert.deepEqual([...sel.keys()].sort(), ['login', 'order', 'register']);
});

test('a module suite selects whole cases of that module', () => {
  const sel = selectRows([kase('a', { module: 'Cart' }), kase('b', { module: 'Login' })], { name: 'cart', modules: ['Cart'] });
  assert.deepEqual([...sel.keys()], ['a']);
});

test('pagePath keeps meaningful query values and drops tracking ones', () => {
  assert.equal(pagePath('https://x.test/widget.html?venue=abc&utm_source=mail&fbclid=1'), '/widget.html?venue=abc');
  assert.equal(pagePath('https://x.test/a/b'), '/a/b');
});

test('withBaseQuery adds the environment query to same-site addresses only', () => {
  const base = 'http://localhost:4173/widget.html?venue=abc&utm_source=x';
  assert.equal(withBaseQuery('/profile.html', base), '/profile.html?venue=abc');
  assert.equal(withBaseQuery('/profile.html?venue=zzz', base), '/profile.html?venue=zzz');
  assert.equal(withBaseQuery('https://other.test/a', base), 'https://other.test/a');
  assert.equal(withBaseQuery('/a', 'http://localhost:4173'), '/a');
});

test('sameAddress matches path and the saved query values', () => {
  assert.ok(sameAddress('/widget.html?venue=abc', 'http://h.test/widget.html?venue=abc&step=2'));
  assert.ok(!sameAddress('/widget.html?venue=abc', 'http://h.test/widget.html?venue=xyz'));
  assert.ok(sameAddress('/cart/', 'http://h.test/cart'));
  assert.ok(!sameAddress('/cart', 'http://h.test/checkout'));
});
