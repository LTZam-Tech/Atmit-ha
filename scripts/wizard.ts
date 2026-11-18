/**
 * Setup Wizard back-end — called by the Control Panel (one command per process).
 *
 *   tsx scripts/wizard.ts <command> <base64-json>
 *   prints progress lines, then one line:  @@RESULT <json>
 *
 * Commands
 *   check         reach the site, detect test-id attribute, language, login form
 *   analyzeLogin  harvest the login page and guess username / password / submit
 *   create        write apps/<key>/ (app.yml, secrets.yml, messages.yml, or/login.page.yml)
 *   bootstrap     (APP=<key>) test the login, save the session, harvest the home page,
 *                 set login.success and generate starter cases
 */
import { pagePath, withBaseQuery } from '../src/utils/url';
import { settlePage, spinnerVisible } from '../src/utils/settle';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, selectors, type Browser, type Page } from '@playwright/test';
import YAML from 'yaml';
import { appDir, casesDir, listApps, orDir, setCurrentApp } from '../src/core/app';
import { detectLoginFields, harvestPage, pickReadyElement, type Harvested } from '../src/core/harvest';
import { boxOf, pageSize, saveVisual, visualDir } from '../src/core/visual';

const [command, payload] = process.argv.slice(2);
const input = payload ? JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) : {};
const log = (m: string) => console.log(m);
const done = (r: unknown) => console.log('@@RESULT ' + JSON.stringify(r));

const TESTID_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-test-id', 'data-automation-id', 'data-automation'];
const SCHEMA_OR = '../../../src/core/or/or.schema.json';

interface SiteOpts { baseURL: string; ignoreHTTPSErrors?: boolean; httpCredentials?: { username: string; password: string }; testIdAttribute?: string }

async function openSite(o: SiteOpts, pathname?: string, storageState?: string): Promise<{ browser: Browser; page: Page; url: string }> {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    ignoreHTTPSErrors: !!o.ignoreHTTPSErrors,
    httpCredentials: o.httpCredentials?.username ? o.httpCredentials : undefined,
    storageState, viewport: { width: 1280, height: 800 },
  });
  // no path → the address exactly as given (with its ?query); a path → on the same site, keeping the address's query values
  const url = pathname ? withBaseQuery(new URL(pathname, o.baseURL).toString(), o.baseURL) : o.baseURL;
  log(`→ Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (await spinnerVisible(page)) log('… waiting for the page to finish loading');
  await settlePage(page, { idle: 8000 });
  return { browser, page, url };
}

const shot = async (page: Page) => 'data:image/png;base64,' + (await page.screenshot({ type: 'png' })).toString('base64');

function pageDoc(key: string, url: string, items: Harvested[], extra: Record<string, unknown>) {
  return `# yaml-language-server: $schema=${SCHEMA_OR}\n` + YAML.stringify({
    page: key, url, ...extra, settings: { timeout: 10000 },
    elements: Object.fromEntries(items.map((i) => [i.name, i.def])),
  }, { lineWidth: 0 });
}

// ------------------------------------------------------------------ commands
const commands: Record<string, () => Promise<unknown>> = {
  async check() {
    const { browser, page } = await openSite(input);
    try {
      const info = await page.evaluate((attrs) => ({
        title: document.title,
        lang: document.documentElement.lang || '',
        dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
        counts: attrs.map((a) => ({ attr: a, count: document.querySelectorAll(`[${a}]`).length })),
        password: !!document.querySelector('input[type=password]'),
        inputs: document.querySelectorAll('input,select,textarea').length,
      }), TESTID_ATTRS);
      const best = [...info.counts].sort((a, b) => b.count - a.count)[0];
      return {
        ok: true, finalURL: page.url(), title: info.title, lang: info.lang, dir: info.dir,
        testIdCandidates: info.counts.filter((c) => c.count > 0),
        suggestedTestId: best.count > 0 ? best.attr : 'data-testid',
        hasPasswordField: info.password, inputs: info.inputs,
        loginPath: info.password ? pagePath(page.url()) : '',
        arabic: /^ar/i.test(info.lang) || info.dir === 'rtl',
        screenshot: await shot(page),
      };
    } finally { await browser.close(); }
  },

  async analyzeLogin() {
    selectors.setTestIdAttribute(input.testIdAttribute || 'data-testid');
    const { browser, page } = await openSite(input, input.loginPath);
    try {
      const items = await harvestPage(page, input.testIdAttribute || 'data-testid', 40);
      const guess = detectLoginFields(items);
      log(guess.password
        ? `✔ ${items.length} element(s) found — username: ${guess.username ?? '?'}, password: ${guess.password}, submit: ${guess.submit ?? '?'}`
        : `ℹ ${items.length} element(s) found, but no password field on ${page.url()} — if the site has no login choose "No login needed", otherwise set the login page path`);
      return {
        finalURL: page.url(), loginPath: pagePath(page.url()), guess, screenshot: await shot(page),
        elements: items.map((i) => ({ name: i.name, def: i.def, role: i.meta.role, tag: i.meta.tag, type: i.meta.type, label: i.meta.name })),
      };
    } finally { await browser.close(); }
  },

  async create() {
    const key: string = input.key;
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error('App key must be lowercase letters, digits or "-", e.g. clinic-portal');
    if (listApps().includes(key) && !input.overwrite) throw new Error(`apps/${key} already exists`);
    const dir = appDir(key);
    fs.mkdirSync(path.join(dir, 'or'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cases'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });

    const env: Record<string, unknown> = { baseURL: input.baseURL };
    if (input.ignoreHTTPSErrors) env.ignoreHTTPSErrors = true;
    const users: Record<string, { username: string }> = {};
    const secrets: { users: Record<string, { password: string }>; environments?: Record<string, unknown> } = { users: {} };
    for (const u of input.users ?? []) {
      if (!u.key || !u.username) continue;
      users[u.key] = { username: u.username };
      if (u.password) secrets.users[u.key] = { password: u.password };
    }
    if (input.httpCredentials?.username) secrets.environments = { [input.envName]: { httpCredentials: input.httpCredentials } };

    const app: Record<string, unknown> = {
      name: input.name, ...(input.description ? { description: input.description } : {}),
      testIdAttribute: input.testIdAttribute || 'data-testid',
      languages: input.languages?.length ? input.languages : ['en'],
      environments: { [input.envName || 'uat']: env },
    };
    const m = input.login?.mapping;
    if (input.login && m?.username && m?.password && m?.submit) {
      app.login = { page: 'login', fields: { username: 'username', password: 'password', submit: 'submit' } };
      // login page: rename the mapped elements to standard names
      const rename: Record<string, string> = { [m.username]: 'username', [m.password]: 'password', [m.submit]: 'submit' };
      const used = new Set(Object.values(rename));
      const items: Harvested[] = (input.login.elements as { name: string; def: Record<string, unknown> }[])
        .filter((e) => rename[e.name] || !used.has(e.name))
        .map((e) => ({ name: rename[e.name] ?? e.name, def: e.def, meta: {} as Harvested['meta'] }));
      fs.writeFileSync(path.join(dir, 'or', 'login.page.yml'),
        pageDoc('login', input.login.path || '/', items, { description: 'Login screen (Setup Wizard)', readyWhen: 'submit', auth: 'none', tags: ['@login'] }));
    }
    if (Object.keys(users).length) app.users = users;

    fs.writeFileSync(path.join(dir, 'app.yml'), `# yaml-language-server: $schema=../../src/core/app.schema.json\n# Created by the Setup Wizard on ${new Date().toISOString().slice(0, 10)}\n` + YAML.stringify(app, { lineWidth: 0 }));
    fs.writeFileSync(path.join(dir, 'secrets.yml'), '# Passwords and basic-auth — git-ignored, never commit\n' + YAML.stringify(secrets));
    if (!fs.existsSync(path.join(dir, 'messages.yml'))) {
      const langs = app.languages as string[];
      fs.writeFileSync(path.join(dir, 'messages.yml'), '# Expected UI messages — use in cases as {{msg.<key>}}\nen: {}\n' + (langs.includes('ar') ? 'ar: {}\n' : ''));
    }
    setCurrentApp(key);
    log(`✔ apps/${key}/ created`);
    return { key };
  },

  async bootstrap() {
    // runs with APP=<key>: now the app exists and the run environment can load it
    const { environment, appConfig } = await import('../config/environment');
    const { SmartOR } = await import('../src/core/or/resolver');
    const { authFile } = await import('../src/core/pages-setup');
    selectors.setTestIdAttribute(environment.testIdAttribute);
    const site: SiteOpts = { baseURL: environment.baseURL, ignoreHTTPSErrors: environment.ignoreHTTPSErrors, httpCredentials: environment.httpCredentials };
    const result: Record<string, unknown> = {};
    const login = appConfig.login;
    const firstUser = Object.keys(appConfig.users)[0];
    let storage: string | undefined;
    let landing = pagePath(site.baseURL);

    if (login && firstUser) {
      const creds = appConfig.users[firstUser];
      const loginDef = (await import('../src/core/or/loader')).readRepository(orDir(environment.app)).get(login.page)!;
      const { browser, page } = await openSite(site, loginDef.url);
      try {
        const or = new SmartOR(page, login.page, { dir: orDir(environment.app) });
        const loginBoxes: Record<string, unknown> = {};
        for (const name of Object.keys(loginDef.elements)) {
          const loc = await or.el(name, {}, { timeout: 1500 }).catch(() => null);
          loginBoxes[name] = loc ? await boxOf(loc) : null;
        }
        saveVisual(visualDir(orDir(environment.app)), login.page, await page.screenshot({ fullPage: true }), {
          url: page.url(), ...(await pageSize(page)), captured: new Date().toISOString(), boxes: loginBoxes as never,
        });
        log(`→ Logging in as "${firstUser}" (${creds.username})`);
        await (await or.el(login.fields.username)).fill(creds.username);
        await (await or.el(login.fields.password)).fill(creds.password ?? '');
        const before = page.url();
        await (await or.el(login.fields.submit)).click();
        await page.waitForURL((u) => u.toString() !== before, { timeout: 15_000 }).catch(() => {});
        await settlePage(page, { idle: 8000 });
        const formGone = (await or.locator(login.fields.password).count()) === 0 || !(await or.locator(login.fields.password).isVisible());
        result.loginOk = formGone;
        result.landingURL = page.url();
        result.screenshot = await shot(page);
        if (!formGone) {
          const err = await page.locator('[role=alert], .error, .alert, [class*=error]').first().textContent({ timeout: 1000 }).catch(() => '');
          throw Object.assign(new Error(`Login did not succeed — the login form is still shown.${err ? ` Message on page: "${err.trim()}"` : ''} Check the user/password and the field mapping.`), { screenshot: result.screenshot });
        }
        storage = authFile(firstUser);
        fs.mkdirSync(path.dirname(storage), { recursive: true });
        await page.context().storageState({ path: storage });
        landing = pagePath(page.url());
        log(`✔ Logged in → ${page.url()} — session saved`);
      } finally { await browser.close(); }
    }

    // home page = first page after login (or the site root)
    const { browser, page } = await openSite(site, landing, storage);
    try {
      const items = await harvestPage(page, environment.testIdAttribute, 60);
      const ready = pickReadyElement(items);
      fs.writeFileSync(path.join(orDir(environment.app), 'home.page.yml'),
        pageDoc('home', landing, items, { description: 'Home page (Setup Wizard)', readyWhen: ready, auth: storage ? firstUser : 'none', tags: ['@home'] }));
      saveVisual(visualDir(orDir(environment.app)), 'home', await page.screenshot({ fullPage: true }), {
        url: page.url(), ...(await pageSize(page)), captured: new Date().toISOString(),
        boxes: Object.fromEntries(items.map((i) => [i.name, i.meta.box.w || i.meta.box.h ? i.meta.box : null])),
      });
      log(`✔ Home page harvested — ${items.length} element(s), ready when "${ready}"`);
      result.homeElements = items.length;
      result.homeScreenshot = await shot(page);

      // login.success + starter cases
      if (login && storage) {
        const appFile = path.join(appDir(environment.app), 'app.yml');
        const doc = YAML.parseDocument(fs.readFileSync(appFile, 'utf8'));
        doc.setIn(['login', 'success'], doc.createNode(ready ? { element: `home.${ready}` } : { urlContains: landing }, { flow: true }));
        fs.writeFileSync(appFile, doc.toString({ lineWidth: 0 }));
        writeCase('login-smoke', {
          case: 'Login smoke', description: 'Generated by the Setup Wizard — edit freely in the Case Builder', page: 'login', tags: ['@smoke'],
          steps: [
            { fill: { element: 'login.username', value: '{{data.username}}' } },
            { fill: { element: 'login.password', value: '{{data.password}}' } },
            { click: 'login.submit' },
          ],
          outcomes: {
            success: [...(ready ? [{ visible: `home.${ready}` }] : []), { url: { contains: landing } }],
            stays_on_login: [{ visible: 'login.password' }, { visible: 'login.submit' }],
          },
          data: [
            { id: 'TC-SMOKE-001', title: 'valid user logs in', type: 'positive', outcome: 'success', username: `{{user.${firstUser}.username}}`, password: `{{user.${firstUser}.password}}` },
            { id: 'TC-SMOKE-101', title: 'wrong password is rejected', type: 'negative', outcome: 'stays_on_login', username: `{{user.${firstUser}.username}}`, password: '{{faker.internet.password}}' },
            { id: 'TC-SMOKE-102', title: 'empty password is rejected', type: 'negative', outcome: 'stays_on_login', username: `{{user.${firstUser}.username}}`, password: '' },
            { id: 'TC-SMOKE-103', title: 'SQL injection in username is rejected', type: 'negative', outcome: 'stays_on_login', username: '{{negative.sqlInjection}}', password: '{{faker.internet.password}}' },
          ],
        });
      }
      if (ready) {
        writeCase('home-smoke', {
          case: 'Home page smoke', description: 'Generated by the Setup Wizard', page: 'home', tags: ['@smoke'],
          steps: [{ visible: `home.${ready}` }],
          data: [{ id: 'TC-HOME-001', title: 'home page loads', type: 'positive' }],
        });
      }
      result.cases = fs.readdirSync(casesDir(environment.app)).filter((f) => f.endsWith('.case.yml'));
      return result;
    } finally { await browser.close(); }
  },
};

function writeCase(name: string, body: Record<string, unknown>) {
  const file = path.join(casesDir(process.env.APP!), `${name}.case.yml`);
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, YAML.stringify(body, { lineWidth: 0 }));
  log(`✔ Starter case → cases/${name}.case.yml`);
}

(async () => {
  const fn = commands[command];
  if (!fn) throw new Error(`Unknown command "${command}"`);
  done({ ok: true, ...((await fn()) as object) });
})().catch((e) => {
  console.error('✖ ' + (e.message ?? e));
  done({ ok: false, error: String(e.message ?? e), screenshot: e.screenshot });
  process.exitCode = 1;
});
