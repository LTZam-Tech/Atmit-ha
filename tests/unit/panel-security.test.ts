import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, type GuardInput } from '../../panel/security';

const PORT = 4400;
const req = (over: Partial<GuardInput>): GuardInput => ({ method: 'GET', path: '/api/state', host: `localhost:${PORT}`, port: PORT, ...over });
const json = 'application/json';

test('allows the panel page and API from the panel itself', () => {
  assert.equal(checkRequest(req({ path: '/', secFetchSite: 'none', secFetchMode: 'navigate' })), null);
  assert.equal(checkRequest(req({ secFetchSite: 'same-origin' })), null);
  assert.equal(checkRequest(req({ host: `127.0.0.1:${PORT}` })), null);
  assert.equal(checkRequest(req({ host: `[::1]:${PORT}` })), null);
});

test('allows a same-origin JSON write', () => {
  const r = req({ method: 'POST', path: '/api/run', origin: `http://localhost:${PORT}`, secFetchSite: 'same-origin', contentType: `${json}; charset=utf-8` });
  assert.equal(checkRequest(r), null);
});

test('blocks DNS rebinding: an unknown Host header', () => {
  assert.equal(checkRequest(req({ host: `evil.example:${PORT}` }))?.status, 421);
  assert.equal(checkRequest(req({ host: undefined }))?.status, 421);
  assert.equal(checkRequest(req({ host: 'localhost:9999' }))?.status, 421);
});

test('blocks a cross-site write even with a JSON body', () => {
  const r = req({ method: 'POST', path: '/api/run', origin: 'https://evil.example', contentType: json });
  assert.equal(checkRequest(r)?.status, 403);
});

test('blocks a sandboxed page (Origin: null)', () => {
  assert.equal(checkRequest(req({ method: 'POST', origin: 'null', contentType: json }))?.status, 403);
});

test('blocks a cross-site read of the API', () => {
  assert.equal(checkRequest(req({ secFetchSite: 'cross-site', secFetchMode: 'cors' }))?.status, 403);
  // even a top-level navigation must not reach /api/
  assert.equal(checkRequest(req({ secFetchSite: 'cross-site', secFetchMode: 'navigate' }))?.status, 403);
});

test('lets a link from another site open the panel page', () => {
  assert.equal(checkRequest(req({ path: '/', secFetchSite: 'cross-site', secFetchMode: 'navigate' })), null);
});

test('blocks a cross-site image or script load of panel files', () => {
  assert.equal(checkRequest(req({ path: '/report/index.html', secFetchSite: 'cross-site', secFetchMode: 'no-cors' }))?.status, 403);
});

test('requires a JSON body type on writes (form posts cannot send one cross-site)', () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = req({ method, origin: `http://localhost:${PORT}`, contentType: 'text/plain' });
    assert.equal(checkRequest(r)?.status, 415, method);
  }
  assert.equal(checkRequest(req({ method: 'POST', origin: `http://localhost:${PORT}` }))?.status, 415);
});

test('host and origin matching ignore letter case', () => {
  const r = req({ method: 'PUT', host: `LocalHost:${PORT}`, origin: `HTTP://LOCALHOST:${PORT}`, contentType: json });
  assert.equal(checkRequest(r), null);
});
