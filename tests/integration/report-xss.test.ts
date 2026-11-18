/**
 * Threat model T9: test data shown in the Smart Report must never run as script.
 * A synthetic test whose title, tags, step title, saved value, heal and error carry script payloads is fed to
 * the real reporter; the generated HTML is opened in Chromium and must not execute any of them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import type { FullConfig, FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import SmartReporter from '../../reporters/smart-reporter';

const IMG = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const SCRIPT = '</script><script>window.__xss=(window.__xss||0)+1</script>';
const SVG = '<svg onload="window.__xss=(window.__xss||0)+1">';

let browser: Browser;
let dir: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atimtha-xss-'));
  process.env.REPORT_OPEN = 'never';
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeTest(): TestCase {
  return {
    id: 'xss-1',
    title: `Login ${IMG}`,
    tags: ['@negative', `@x${SVG}`],
    titlePath: () => ['', 'chromium', 'cases.spec.ts', `Module ${SCRIPT}`, `Login ${IMG}`],
    location: { file: path.join(process.cwd(), 'tests', 'cases.spec.ts'), line: 1, column: 1 },
    parent: { project: () => ({ name: 'chromium' }) },
    annotations: [
      { type: 'runtime-value', description: `orderNo = ${IMG}` },
      { type: 'or-healed', description: `login.user: ${SVG}` },
      { type: 'healing', description: JSON.stringify({ kind: 'fallback-locator', target: `login.${IMG}`, purpose: 'check', original: SCRIPT, healedBy: SVG, fix: IMG }) },
      { type: 'last-page', description: JSON.stringify({ url: `https://x.test/?q=${IMG}`, title: SCRIPT, page: null }) },
    ],
  } as unknown as TestCase;
}

function fakeResult(): TestResult {
  return {
    status: 'failed', retry: 0, duration: 1200, attachments: [],
    errors: [{ message: `expect(locator).toHaveText(expected)\nExpected: "${SCRIPT}"\nReceived: "${IMG}"` }],
    steps: [{ title: `Type ${IMG} into login.user`, category: 'test.step', duration: 10, steps: [] }],
  } as unknown as TestResult;
}

test('the Smart Report renders hostile test data as text, never as script', async () => {
  const reporter = new SmartReporter({ outputFolder: dir, open: 'never', history: false });
  reporter.onBegin({ metadata: { app: 'demo' }, version: 'test' } as unknown as FullConfig, {} as never);
  reporter.onTestEnd(fakeTest(), fakeResult());
  reporter.onEnd({ status: 'failed', duration: 1200 } as unknown as FullResult);

  const file = path.join(dir, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  // the embedded data must not be able to close the <script> that carries it
  assert.ok(!html.includes('</script><script>window.__xss'), 'raw payload closes the data script tag');

  const page = await browser.newPage();
  let dialogs = 0;
  page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
  await page.goto(pathToFileURL(file).toString());
  // open every test card so lazy content renders too
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await page.waitForTimeout(300);

  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0), 0, 'a payload executed');
  assert.equal(dialogs, 0);
  // and the payload is visible as text, so the tester still sees what the test used
  assert.ok((await page.locator('body').innerText()).includes('onerror='), 'payload text should be shown literally');
  await page.close();
});
