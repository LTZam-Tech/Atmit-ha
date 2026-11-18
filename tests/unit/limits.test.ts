import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import AdmZip from 'adm-zip';
import { HttpError, checkZip, isInside, readLimitedBody, safeArg, ZIP_LIMITS, type ZipEntryInfo } from '../../panel/limits';

/** a fake request: a stream with headers */
const fakeReq = (body: string | Buffer, headers: Record<string, string> = {}) => {
  const s = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
  (s as any).headers = headers;
  process.nextTick(() => { (s as any).end(body); });
  return s;
};

const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

test('readLimitedBody parses JSON and an empty body', async () => {
  assert.deepEqual(await readLimitedBody(fakeReq('{"a":1}')), { a: 1 });
  assert.deepEqual(await readLimitedBody(fakeReq('')), {});
});

test('readLimitedBody refuses bodies over the limit, by header and by bytes received', async () => {
  assert.equal(await status(readLimitedBody(fakeReq('{}', { 'content-length': String(5_000_000) }), 1_000_000)), 413);
  assert.equal(await status(readLimitedBody(fakeReq(Buffer.alloc(2048, 'a')), 1024)), 413);
});

test('readLimitedBody answers 400 to invalid JSON instead of treating it as empty', async () => {
  assert.equal(await status(readLimitedBody(fakeReq('{not json'))), 400);
});

test('safeArg refuses option-like, control-character and over-long values', () => {
  assert.equal(safeArg('/login', 'x'), '/login');
  assert.equal(safeArg('Create patient', 'x'), 'Create patient');
  assert.equal(safeArg('https://site.test/a?b=-1', 'x'), 'https://site.test/a?b=-1');
  assert.throws(() => safeArg('--auth', 'x'), /must not start with "-"/);
  assert.throws(() => safeArg('-x', 'x'), HttpError);
  assert.throws(() => safeArg('a\nb', 'x'), /control characters/);
  assert.throws(() => safeArg('a'.repeat(11), 'x', 10), /too long/);
});

test('isInside compares whole path segments', () => {
  const base = path.resolve('reports', 'smart-report');
  assert.ok(isInside(base, path.join(base, 'index.html')));
  assert.ok(isInside(base, path.join(base, 'data', 'a.png')));
  assert.ok(isInside(base, base));
  assert.ok(!isInside(base, path.resolve('reports', 'smart-report-evil', 'x.html')), 'sibling folder with the same prefix');
  assert.ok(!isInside(base, path.join(base, '..', 'history', 'x')));
  assert.ok(!isInside(base, path.resolve('/etc/passwd')));
});

const entry = (entryName: string, size = 100, compressedSize = 50, isDirectory = false): ZipEntryInfo => ({ entryName, isDirectory, header: { size, compressedSize } });

test('checkZip accepts a normal project export', () => {
  assert.doesNotThrow(() => checkZip(10_000, [entry('demo/', 0, 0, true), entry('demo/app.yml'), entry('demo/cases/a.case.yml'), entry('demo\\or\\login.page.yml')], 'demo'));
});

test('checkZip refuses zip-slip and absolute paths', () => {
  assert.throws(() => checkZip(1000, [entry('demo/app.yml'), entry('demo/../../evil.js')], 'demo'), /unsafe path/);
  assert.throws(() => checkZip(1000, [entry('demo/app.yml'), entry('/etc/x')], 'demo'), /unsafe path/);
  assert.throws(() => checkZip(1000, [entry('demo/app.yml'), entry('C:/Windows/x')], 'demo'), /unsafe path/);
  assert.throws(() => checkZip(1000, [entry('demo/app.yml'), entry('other/app.yml')], 'demo'), /outside the project folder/);
});

test('checkZip refuses oversized archives, too many files and zip bombs', () => {
  assert.throws(() => checkZip(ZIP_LIMITS.archiveBytes + 1, [entry('demo/app.yml')], 'demo'), /too large/);
  const many = Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => entry(`demo/f${i}.yml`));
  assert.throws(() => checkZip(1000, many, 'demo'), /too many files/);
  assert.throws(() => checkZip(1000, [entry('demo/bomb.yml', 40 * 1024 * 1024, 10 * 1024)], 'demo'), /expands too much/);
  const big = Array.from({ length: 5 }, (_, i) => entry(`demo/big${i}.bin`, 45 * 1024 * 1024, 40 * 1024 * 1024));
  assert.throws(() => checkZip(1000, big, 'demo'), /expands to more than/);
});

test('checkZip reads real adm-zip entries, including a crafted traversal entry', () => {
  const zip = new AdmZip();
  zip.addFile('demo/app.yml', Buffer.from('name: Demo\n'));
  zip.addFile('demo/cases/a.case.yml', Buffer.from('case: A\n'));
  const ok = new AdmZip(zip.toBuffer());
  assert.doesNotThrow(() => checkZip(zip.toBuffer().length, ok.getEntries(), 'demo'));

  const evil = new AdmZip();
  evil.addFile('demo/app.yml', Buffer.from('name: Demo\n'));
  evil.addFile('demo/x.yml', Buffer.from('x'));
  evil.getEntries()[1].entryName = 'demo/../../../escape.txt';
  const read = new AdmZip(evil.toBuffer());
  assert.throws(() => checkZip(1000, read.getEntries(), 'demo'), /unsafe path|outside the project/);
});
