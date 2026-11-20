/**
 * Mobile test engine — runs `engine: mobile` steps on an Appium session (backlog §8). One session per test: the
 * app is started from the project's capabilities and closed afterwards; a failure attaches a screenshot of the device.
 */
import { expect, test } from '@playwright/test';
import { step } from '../../utils/steps';
import { environment } from '../../../config/environment';
import { loadApp } from '../app';
import { loadRepository } from '../or/loader';
import { parseElementRef, type Step } from '../cases/model';
import { render, type TemplateContext } from '../cases/template';
import { renderDeep } from '../api-engine/runner';
import type { MobileLocator } from './model';
import { WebDriver } from './webdriver';

const DEFAULT_WAIT_MS = 10_000;

export interface MobileSettings { appiumUrl?: string; capabilities: Record<string, unknown>; waitTimeoutMs?: number }

/** app.yml `mobile` (capabilities may use {{env.*}} and secrets); APPIUM_URL on the agent wins (its own device farm) */
export function mobileSettings(): MobileSettings {
  const cfg = loadApp(environment.app) as unknown as { mobile?: MobileSettings };
  if (!cfg.mobile?.capabilities) throw new Error('This project has no mobile settings: add "mobile: { capabilities: { platformName, appium:app … } }" to app.yml');
  return cfg.mobile;
}

/** inline locator or "page.element" → a WebDriver strategy */
export function strategyOf(locator: MobileLocator): { using: string; value: string; label: string } {
  let l: Record<string, unknown>;
  if (typeof locator === 'string') {
    const ref = parseElementRef(locator);
    const el = ref && loadRepository().get(ref.page)?.elements[ref.element];
    if (!el) throw new Error(`${locator} is not in the object repository`);
    const e = el as unknown as Record<string, unknown>;
    l = e.testid ? { accessibility: e.testid } : e.id ? { id: e.id } : e.xpath ? { xpath: e.xpath } : e.text ? { text: e.text } : {};
    if (!Object.keys(l).length) throw new Error(`${locator}: a mobile element needs testid, id, xpath or text`);
  } else l = locator as Record<string, unknown>;
  const [key, raw] = Object.entries(l)[0];
  // bilingual texts in the repository: the run language picks the value
  const value = typeof raw === 'object' && raw ? String((raw as Record<string, unknown>)[environment.locale] ?? Object.values(raw)[0]) : String(raw);
  const q = JSON.stringify(value);
  switch (key) {
    case 'accessibility': return { using: 'accessibility id', value, label: `~${value}` };
    case 'id': return { using: 'id', value, label: `#${value}` };
    case 'xpath': return { using: 'xpath', value, label: value };
    case 'uiautomator': return { using: '-android uiautomator', value, label: value };
    case 'predicate': return { using: '-ios predicate string', value, label: value };
    case 'classChain': return { using: '-ios class chain', value, label: value };
    case 'text': return { using: 'xpath', value: `//*[@text=${q} or @label=${q} or @name=${q} or @content-desc=${q} or @value=${q}]`, label: `"${value}"` };
    default: throw new Error(`unknown mobile locator "${key}"`);
  }
}

export class MobileSession {
  private constructor(readonly driver: WebDriver, readonly settings: MobileSettings) {}

  static async open(): Promise<MobileSession> {
    const settings = mobileSettings();
    const url = process.env.APPIUM_URL ?? settings.appiumUrl;
    if (!url) throw new Error('No Appium server: set mobile.appiumUrl in app.yml or APPIUM_URL on the agent');
    const caps = renderDeep(settings.capabilities, { data: {}, faker: undefined as never, vars: {} }) as Record<string, unknown>;
    const driver = await step.setup(`Start the app on ${String(caps.platformName ?? 'the device')}`, () => WebDriver.create(url, caps));
    return new MobileSession(driver, settings);
  }

  private get wait() { return this.settings.waitTimeoutMs ?? DEFAULT_WAIT_MS; }

  /** waits until the element exists (and, when asked, is displayed) */
  async element(locator: MobileLocator, opts: { displayed?: boolean; timeout?: number } = {}): Promise<string> {
    const s = strategyOf(locator);
    const until = Date.now() + (opts.timeout ?? this.wait);
    do {
      const id = await this.driver.find(s.using, s.value);
      if (id && (!opts.displayed || (await this.driver.displayed(id)))) return id;
      await new Promise((r) => setTimeout(r, 300));
    } while (Date.now() < until);
    throw new Error(`Element ${s.label} not found on the screen within ${Math.round((opts.timeout ?? this.wait) / 1000)} s`);
  }

  async attachScreenshot(name: string) {
    const png = await this.driver.screenshot().catch(() => undefined);
    if (png) await test.info().attach(name, { body: png, contentType: 'image/png' });
  }

  async close() { await this.driver.quit(); }
}

export async function runMobileSteps(m: MobileSession, steps: Step[], ctx: TemplateContext) {
  for (const s of steps) await runMobileStep(m, s, ctx);
}

async function runMobileStep(m: MobileSession, s: Step, ctx: TemplateContext) {
  const b = (s.mobile ?? {}) as Record<string, unknown>;
  const el = b.element as MobileLocator;
  const label = () => strategyOf(el).label;
  const title = (t: string) => s.name ?? t;
  const appId = () => String(b.app ?? m.settings.capabilities['appium:appPackage'] ?? m.settings.capabilities['appium:bundleId'] ?? '');

  switch (s.action as string) {
    case 'launch': return step.navigate(title('Open the app'), async () => { if (appId()) await m.driver.activateApp(render(appId(), ctx)); });
    case 'close': return step.navigate(title('Close the app'), async () => { if (appId()) await m.driver.terminateApp(render(appId(), ctx)); });
    case 'back': return step.navigate(title('Back'), () => m.driver.back());
    case 'hideKeyboard': return step.enter(title('Hide the keyboard'), () => m.driver.hideKeyboard());
    case 'tap': return step.click(title(`Tap ${label()}`), async () => m.driver.click(await m.element(el, { displayed: true })));
    case 'clear': return step.enter(title(`Clear ${label()}`), async () => m.driver.clear(await m.element(el, { displayed: true })));
    case 'type': {
      const value = render(String(b.value), ctx);
      return step.enter(title(`Type into ${label()}`), async () => {
        const id = await m.element(el, { displayed: true });
        await m.driver.clear(id).catch(() => undefined);
        await m.driver.type(id, value);
      });
    }
    case 'swipe': return step.click(title(`Swipe ${String(b.direction)}`), async () => {
      const r = b.element ? await m.driver.rect(await m.element(el)) : await m.driver.rect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, dx = r.width * 0.35, dy = r.height * 0.35;
      const to = { up: { x: cx, y: cy - dy }, down: { x: cx, y: cy + dy }, left: { x: cx - dx, y: cy }, right: { x: cx + dx, y: cy } }[String(b.direction) as 'up'];
      const from = { x: cx * 2 - to.x, y: cy * 2 - to.y };
      await m.driver.swipe(from, to);
    });
    case 'visible':
    case 'wait': return step.verify(title(`${label()} is visible`), async () => { await m.element(el, { displayed: true, timeout: Number(b.timeout) || undefined }); });
    case 'hidden': return step.verify(title(`${label()} is not visible`), async () => {
      const s2 = strategyOf(el);
      const until = Date.now() + (Number(b.timeout) || 5_000);
      for (;;) {
        const id = await m.driver.find(s2.using, s2.value);
        if (!id || !(await m.driver.displayed(id).catch(() => false))) return;
        if (Date.now() > until) throw new Error(`${s2.label} is still visible`);
        await new Promise((r) => setTimeout(r, 300));
      }
    });
    case 'text': {
      const matcher = 'equals' in b ? 'equals' : 'contains';
      const expected = render(String(b[matcher]), ctx);
      return step.verify(title(`${label()} text ${matcher} "${expected}"`), async () => {
        const actual = (await m.driver.text(await m.element(el, { displayed: true }))).trim();
        if (matcher === 'equals') expect(actual, `text of ${label()}`).toBe(expected);
        else expect(actual, `text of ${label()}`).toContain(expected);
      });
    }
    case 'save': return step.enter(title(`Save ${label()} as {{var.${String(b.as)}}}`), async () => {
      ctx.vars = ctx.vars ?? {};
      ctx.vars[String(b.as)] = (await m.driver.text(await m.element(el))).trim();
    });
    case 'screenshot': return step.verify(title('Screenshot'), () => m.attachScreenshot(String(b.name ?? 'screen')));
    default: throw new Error(`unknown mobile action "${s.action}"`);
  }
}
