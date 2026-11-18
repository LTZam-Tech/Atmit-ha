import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStep, parseElementRef, serializeStep, outcomeFor, varsUsed, dataFieldsUsed, ACTIONS } from '../../src/core/cases/model';

test('parseElementRef reads page, element and parameters', () => {
  assert.deepEqual(parseElementRef('login.submit'), { page: 'login', element: 'submit', params: {} });
  assert.deepEqual(parseElementRef('inventory.addToCart(sku=backpack, size=M)'), {
    page: 'inventory', element: 'addToCart', params: { sku: 'backpack', size: 'M' },
  });
  assert.deepEqual(parseElementRef('cart.item(sku={{data.sku}})')?.params, { sku: '{{data.sku}}' });
  assert.equal(parseElementRef('no-dot'), undefined);
  assert.equal(parseElementRef('1page.el'), undefined);
});

test('the step model has the 24 documented actions', () => {
  assert.equal(Object.keys(ACTIONS).length, 24);
});

test('normalizeStep accepts the short and long forms', () => {
  assert.deepEqual(normalizeStep({ click: 'login.submit' }, 's1'), { action: 'click', name: undefined, element: 'login.submit' });
  const fill = normalizeStep({ fill: { element: 'login.username', value: '{{data.username}}' } }, 's2');
  assert.equal(fill.element, 'login.username');
  assert.equal(fill.value, '{{data.username}}');
  const text = normalizeStep({ text: { element: 'login.error', contains: 'Epic' } }, 's3');
  assert.equal(text.matcher, 'contains');
  assert.equal(text.expected, 'Epic');
  assert.equal(normalizeStep({ open: 'inventory' }, 's4').page, 'inventory');
  assert.equal(normalizeStep({ press: 'Enter' }, 's5').value, 'Enter');
});

test('normalizeStep rejects malformed steps with a readable message', () => {
  assert.throws(() => normalizeStep({ jump: 'x.y' }, 'step 1'), /unknown action "jump"/);
  assert.throws(() => normalizeStep({ click: 'a.b', fill: 'c.d' }, 'step 2'), /exactly one action/);
  assert.throws(() => normalizeStep({ fill: { element: 'a.b' } }, 'step 3'), /needs a value/);
  assert.throws(() => normalizeStep({ text: { element: 'a.b' } }, 'step 4'), /"equals" or "contains"/);
  assert.throws(() => normalizeStep({ save: { element: 'a.b', as: 'bad name' } }, 'step 5'), /needs "as/);
  assert.throws(() => normalizeStep({ save: { as: 'id', pattern: '(' } }, 'step 6'), /invalid pattern/);
  assert.throws(() => normalizeStep({ click: {} }, 'step 7'), /needs an element/);
});

test('serializeStep round-trips every step form', () => {
  const raws = [
    { click: 'login.submit' },
    { fill: { element: 'login.username', value: 'u' } },
    { text: { element: 'login.error', equals: 'x' } },
    { open: 'inventory' },
    { goto: '/cart' },
    { save: { element: 'cart.orderNo', as: 'orderNo' } },
    { check: { element: 'profile.hobbies', value: 'Music, Reading' } },
    { name: 'custom title', hover: 'menu.item' },
  ];
  for (const raw of raws) assert.deepEqual(serializeStep(normalizeStep(raw, 'x')), raw);
});

test('outcomeFor picks by explicit outcome, then by row type', () => {
  const outcomes = { success: [], error: [] };
  assert.equal(outcomeFor({ outcome: 'error' }, outcomes), 'error');
  assert.equal(outcomeFor({ type: 'positive' }, outcomes), 'success');
  assert.equal(outcomeFor({ type: 'negative' }, outcomes), 'error');
});

test('template references are found', () => {
  assert.deepEqual(varsUsed({ a: '{{var.orderNo}} and {{ var.id }}' }), ['orderNo', 'id']);
  const steps = [normalizeStep({ fill: { element: 'a.b', value: '{{data.email}}' } }, 'x')];
  assert.deepEqual(dataFieldsUsed(steps), ['email']);
});
