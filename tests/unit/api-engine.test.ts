import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tokenize, typeOf } from '../../src/core/api-engine/jsonpath';
import { normalizeApiStep } from '../../src/core/api-engine/model';
import { renderDeep } from '../../src/core/api-engine/runner';
import { fakerEN } from '@faker-js/faker';

const doc = { data: { items: [{ id: 1, sku: 'a' }, { id: 2, sku: 'b' }], total: 2, name: 'x' }, errors: [{ field: 'qty' }], 'odd key': true };

test('jsonpath reads keys, indexes, negative indexes, quoted keys and length', () => {
  assert.deepEqual(evaluate(doc, '$.data.total'), { found: true, value: 2 });
  assert.deepEqual(evaluate(doc, '$.data.items[1].sku'), { found: true, value: 'b' });
  assert.deepEqual(evaluate(doc, '$.data.items[-1].id'), { found: true, value: 2 });
  assert.deepEqual(evaluate(doc, "$['odd key']"), { found: true, value: true });
  assert.deepEqual(evaluate(doc, '$.data.items.length'), { found: true, value: 2 });
  assert.deepEqual(evaluate(doc, '$'), { found: true, value: doc });
});

test('jsonpath wildcards return arrays, missing paths are "not found" (never a crash)', () => {
  assert.deepEqual(evaluate(doc, '$.data.items[*].sku'), { found: true, value: ['a', 'b'] });
  assert.deepEqual(evaluate(doc, '$.errors[*].field'), { found: true, value: ['qty'] });
  assert.equal(evaluate(doc, '$.data.missing').found, false);
  assert.equal(evaluate(doc, '$.data.items[9].id').found, false);
  assert.equal(evaluate(undefined, '$.a').found, false);
  assert.throws(() => tokenize('data.x'), /must start with \$/);
  assert.throws(() => tokenize('$.a..b'), /Invalid JSON path/);
});

test('typeOf uses JSON Schema names', () => {
  assert.equal(typeOf(1), 'integer');
  assert.equal(typeOf(1.5), 'number');
  assert.equal(typeOf(null), 'null');
  assert.equal(typeOf([]), 'array');
  assert.equal(typeOf({}), 'object');
});

test('API steps are validated with readable messages', () => {
  assert.deepEqual(normalizeApiStep({ status: 201 }, 's').api, { equals: 201 });
  assert.equal(normalizeApiStep({ request: { url: '/x' } }, 's').api?.method, 'GET');
  assert.equal(normalizeApiStep({ save: { path: '$.id', as: 'orderId' } }, 's').as, 'orderId');
  assert.throws(() => normalizeApiStep({ request: { method: 'FETCH', url: '/x' } }, 'step 1'), /method must be one of/);
  assert.throws(() => normalizeApiStep({ request: { url: '/x', json: {}, body: 'x' } }, 'step 1'), /only one of json, form, body or multipart/);
  assert.throws(() => normalizeApiStep({ request: { url: '/x', auth: { bearer: 't', basic: {} } } }, 'step 1'), /either/);
  assert.throws(() => normalizeApiStep({ json: { path: 'x', equals: 1 } }, 'step 2'), /path: \$/);
  assert.throws(() => normalizeApiStep({ json: { path: '$.a', equals: 1, contains: 1 } }, 'step 2'), /exactly one of/);
  assert.throws(() => normalizeApiStep({ time: { below: 0 } }, 'step 3'), /below/);
  assert.throws(() => normalizeApiStep({ click: 'a.b' }, 'step 4'), /unknown API action "click"/);
  assert.throws(() => normalizeApiStep({ status: 200, json: {} }, 'step 5'), /exactly one action/);
});

test('renderDeep fills templates everywhere and keeps numbers numeric when a value is one template', () => {
  const ctx = { data: { qty: '2', sku: 'backpack', flag: 'true' }, faker: fakerEN, vars: { token: 't0k' } };
  assert.deepEqual(
    renderDeep({ json: { sku: '{{data.sku}}', qty: '{{data.qty}}', ok: '{{data.flag}}', note: 'qty {{data.qty}}' }, auth: { bearer: '{{var.token}}' } }, ctx),
    { json: { sku: 'backpack', qty: 2, ok: true, note: 'qty 2' }, auth: { bearer: 't0k' } },
  );
});
