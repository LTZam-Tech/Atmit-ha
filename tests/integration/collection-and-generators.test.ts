/**
 * 0.1.0 regression coverage for page collection and the rule-based generators (backlog §6, §16).
 * A real Chromium opens the bundled demo shop; what collection finds is then fed to the Test builder's
 * generators exactly as the panel does, and every generated step must be a valid step of the case model.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from '@playwright/test';
import { harvestPage, pickReadyElement, type Harvested } from '../../src/core/harvest';
import { normalizeStep, serializeStep, type Action } from '../../src/core/cases/model';
import { ROOT } from '../../src/core/app';

// the generators are browser modules of the panel (plain JS, no types)
type Gen = Record<string, any>;
let datagen: Gen, casegen: Gen;

let server: ChildProcess, browser: Browser, base: string;

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  s.on('error', reject);
});

const waitFor = async (url: string) => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`demo app did not start at ${url}`);
};

before(async () => {
  datagen = await import('../../panel/app/datagen.js' as string);
  casegen = await import('../../panel/app/casegen.js' as string);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'demo-app/server.js')], { env: { ...process.env, DEMO_PORT: String(port) }, stdio: 'ignore' });
  await waitFor(`${base}/index.html`);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function collect(pathname: string, loggedIn = false): Promise<{ page: Page; items: Harvested[] }> {
  const ctx = await browser.newContext();
  // the demo shop keeps its session in localStorage: no password needs to be typed
  if (loggedIn) await ctx.addInitScript(() => localStorage.setItem('user', 'standard_user'));
  const page = await ctx.newPage();
  await page.goto(base + pathname);
  return { page, items: await harvestPage(page, 'data-test') };
}

const byName = (items: Harvested[]) => Object.fromEntries(items.map((i) => [i.name, i.def as Record<string, any>]));

/** collected items → the page shape the panel hands to the generators */
const asPanelPage = (key: string, items: Harvested[], readyWhen?: string) => ({
  page: key, readyWhen, auth: 'standard',
  elements: items.map((i) => ({ name: i.name, def: i.def, params: [] as string[] })),
});

test('login page: fields, button, link and error area are found and classified', async () => {
  const { page, items } = await collect('/index.html');
  const el = byName(items);
  assert.equal(el.username?.control, 'textbox');
  assert.equal(el.username?.semantic, 'username');
  assert.equal(el.password?.control, 'password');
  assert.equal(el.loginButton?.control, 'button');
  assert.equal(el.forgotPassword?.control, 'link');
  assert.equal(el.error?.control, 'alert');
  assert.equal(pickReadyElement(items), 'username');
  // every element carries a primary locator and at least one backup (self-healing needs them)
  for (const i of items) assert.ok(Array.isArray(i.def.fallback) && (i.def.fallback as unknown[]).length >= 1, `${i.name} has no fallback`);
  await page.context().close();
});

test('profile form: rules, option groups and date formats are read from the page', async () => {
  const { page, items } = await collect('/profile.html', true);
  const el = byName(items);
  assert.deepEqual(el.fullName?.rules, { required: true, maxlength: 40 });
  assert.equal(el.email?.semantic, 'email');
  assert.equal(el.phone?.semantic, 'phone');
  assert.deepEqual(el.age?.rules, { min: 18, max: 99 });
  assert.equal(el.gender?.control, 'radiogroup');
  assert.equal(el.gender?.options?.length, 2);
  assert.equal(el.interests?.control, 'checkgroup');
  assert.equal(el.interests?.options?.length, 3);
  assert.equal(el.country?.control, 'select');
  assert.equal(el.newsletter?.control, 'checkbox');
  assert.equal(el.visitDate?.control, 'datepicker');
  assert.equal(el.visitDate?.format, 'MM/dd/yyyy');
  assert.equal(el.startDate?.format, 'dd/MM/yyyy');
  assert.equal(el.endDate?.format, 'yyyy-MM-dd');
  assert.equal(el.bio?.control, 'textarea');
  assert.equal(el.saveProfile?.control, 'button');
  await page.context().close();
});

test('⚡ Steps from a page builds a valid form test from the collected profile', async () => {
  const { page, items } = await collect('/profile.html', true);
  const p = asPanelPage('profile', items, pickReadyElement(items));
  const { steps, outcomes, row } = datagen.stepsFromPage(p);
  const actions = steps.map((s: { action: string; element: string }) => `${s.action} ${s.element}`);
  assert.ok(actions.includes('fill profile.fullName'));
  assert.ok(actions.includes('choose profile.gender'));
  assert.ok(actions.includes('select profile.country'));
  assert.ok(actions.includes('check profile.newsletter'));
  assert.equal(actions.at(-1), 'click profile.saveProfile', 'submits with Save, never Logout');
  assert.ok(!actions.some((a: string) => a.includes('logout')));
  assert.equal(row.age, '59', 'midpoint of 18..99');
  assert.equal(row.email, '{{faker.internet.email}}');
  assert.equal(row.visitDate, '{{date.today(MM/dd/yyyy)}}');
  assert.deepEqual(outcomes.find((o: { name: string }) => o.name === 'success').steps, [{ action: 'visible', element: 'profile.profileSaved' }]);
  assert.deepEqual(outcomes.find((o: { name: string }) => o.name === 'error').steps, [{ action: 'visible', element: 'profile.profileError' }]);
  await page.context().close();
});

test('⚙ Generate test data proposes required, boundary and format rows', async () => {
  const { page, items } = await collect('/profile.html', true);
  const el = byName(items);
  const rows = (field: string) => datagen.fieldCases(field, el[field]) as { value: string; type: string; technique: string; checked: boolean }[];
  const has = (field: string, value: string, type: string, technique: string) =>
    assert.ok(rows(field).some((r) => r.value === value && r.type === type && r.technique === technique), `${field}: ${technique} ${type} "${value}"`);

  has('fullName', '', 'negative', 'Required');
  has('fullName', '{{negative.longText(40)}}', 'positive', 'BVA');
  has('age', '18', 'positive', 'BVA');
  has('age', '17', 'negative', 'BVA');
  has('age', '99', 'positive', 'BVA');
  has('age', '100', 'negative', 'BVA');
  has('email', 'not-an-email', 'negative', 'EP');
  has('phone', 'abc12345', 'negative', 'EP');
  // security rows are offered but never ticked by default
  const sec = rows('fullName').filter((r) => r.technique === 'Security');
  assert.ok(sec.length >= 2 && sec.every((r) => !r.checked));
  // number fields get no text attacks (the browser refuses letters there)
  assert.ok(!rows('age').some((r) => r.technique === 'Security'));
  await page.context().close();
});

test('✨ Generate test cases proposes smoke, positive and negative cases made of valid steps', async () => {
  const { page, items } = await collect('/profile.html', true);
  const p = asPanelPage('profile', items, pickReadyElement(items));
  // the slice of the panel state (/api/state) the case generator reads
  const S = { cases: [], login: undefined, usersDetail: [], routes: [], pages: [p] };
  const proposals = casegen.proposeCases(p, S) as { kind: string; title: string; case: { type: string; steps: any[]; outcomes: Record<string, any[]> } }[];
  const kinds = new Set(proposals.map((x) => x.kind));
  assert.ok(kinds.has('smoke'), 'page-opens case');
  assert.ok(kinds.has('form'), 'form cases');
  assert.ok(proposals.some((x) => x.case.type === 'positive' && x.kind === 'form'));
  assert.ok(proposals.some((x) => x.case.type === 'negative'));
  // every generated step (and outcome check) is a step the runner accepts
  for (const x of proposals) {
    for (const s of [...x.case.steps, ...Object.values(x.case.outcomes).flat()]) {
      const raw = serializeStep({ ...s, action: s.action as Action });
      assert.doesNotThrow(() => normalizeStep(raw, `${x.title}`), `${x.title}: ${JSON.stringify(s)}`);
    }
  }
  await page.context().close();
});
