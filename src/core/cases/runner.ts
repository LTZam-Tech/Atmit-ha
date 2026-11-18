/** Executes normalized case steps with the Smart OR, as typed report steps. */
import { expect, test, type Page, type Locator } from '@playwright/test';
import type { UI } from '../../fixtures';
import { step, mask } from '../../utils/steps';
import { ACTIONS, parseElementRef, type Step } from './model';
import { render, type TemplateContext } from './template';
import { smartFill } from './fill';
import { withBaseQuery } from '../../utils/url';
import { environment } from '../../../config/environment';

const isSecret = (ref?: string) => !!ref && /pass(word)?|pwd|secret|otp|pin/i.test(ref);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function runSteps(ui: UI, page: Page, steps: Step[], ctx: TemplateContext): Promise<void> {
  for (const s of steps) await runStep(ui, page, s, ctx);
}

async function runStep(ui: UI, page: Page, s: Step, ctx: TemplateContext): Promise<void> {
  const spec = ACTIONS[s.action];
  const value = s.value !== undefined ? render(s.value, ctx) : undefined;
  const expected = s.expected !== undefined ? render(s.expected, ctx) : undefined;
  const ref = s.element ? parseElementRef(render(s.element, ctx)) : undefined;
  const params = ref ? Object.fromEntries(Object.entries(ref.params).map(([k, v]) => [k, render(v, ctx)])) : {};
  const shown = (v?: string) => (isSecret(s.element) ? mask(v ?? '') : `"${v === '' ? '(empty)' : v}"`);
  const label = s.name ?? defaultTitle(s, ref ? `${ref.page}.${ref.element}` : '', shown(value), expected);

  const el = () => ui.or(ref!.page).el(ref!.element, params);
  const strict = () => ui.or(ref!.page).locator(ref!.element, params); // negative checks & counts — no fallback

  const body = async () => {
    switch (s.action) {
      case 'open': return ui.open(render(s.page, ctx));
      case 'goto': return void (await page.goto(withBaseQuery(render(s.url, ctx), environment.baseURL)));
      case 'fill': {
        const r = await smartFill(await el(), value ?? '');
        const name = `${ref!.page}.${ref!.element}`;
        if (r.direct) test.info().annotations.push({ type: 'readonly-fill', description: `${name} is read-only — value set directly ("${value}")` });
        if (r.converted) test.info().annotations.push({ type: 'date-format', description: `${name}: "${value}" entered as ${r.converted} (the browser's date format)` });
        return;
      }
      case 'clear': return (await el()).clear();
      case 'select': {
        const vals = splitList(value);
        const loc = await el();
        return void (await loc.selectOption(vals.map((label) => ({ label }))).catch(() => loc.selectOption(vals)));
      }
      case 'choose': {
        const loc = await el();
        return (await optionIn(loc, value ?? '')).check();
      }
      case 'check':
      case 'uncheck': {
        const loc = await el();
        const targets = value ? await Promise.all(splitList(value).map((v) => optionIn(loc, v))) : [loc.first()];
        for (const t of targets) await (s.action === 'check' ? t.check() : t.uncheck());
        return;
      }
      case 'click': return (await el()).click();
      case 'dblclick': return (await el()).dblclick();
      case 'hover': return (await el()).hover();
      case 'press': return ref ? (await el()).press(value ?? 'Enter') : page.keyboard.press(value ?? 'Enter');
      case 'visible': case 'waitFor': return expect(await el()).toBeVisible();
      case 'hidden': return expect(strict()).toBeHidden();
      case 'enabled': return expect(await el()).toBeEnabled();
      case 'disabled': return expect(await el()).toBeDisabled();
      case 'text':
        return s.matcher === 'contains' ? expect(await el()).toContainText(expected ?? '') : expect(await el()).toHaveText(expected ?? '');
      case 'value': {
        const control = ui.or(ref!.page).def.elements[ref!.element]?.control;
        if (control === 'radiogroup' || control === 'checkgroup' || control === 'checkbox') {
          // compare the ticked option labels, e.g. "Music, Reading" (single checkbox: "checked" / "unchecked")
          const loc = await el();
          await expect.poll(async () => checkedLabels(loc, control), { message: `${ref!.page}.${ref!.element} ticked options` })
            [s.matcher === 'contains' ? 'toContain' : 'toBe'](expected ?? '');
          return;
        }
        return s.matcher === 'contains' ? expect(await el()).toHaveValue(new RegExp(reEsc(expected ?? ''))) : expect(await el()).toHaveValue(expected ?? '');
      }
      case 'count':
        return expect(strict()).toHaveCount(Number(expected));
      case 'url':
        return expect(page).toHaveURL(s.matcher === 'contains' ? new RegExp(reEsc(expected ?? '')) : new URL(expected ?? '', page.url()).toString());
      case 'link': return checkLink(page, await el(), s.matcher, expected);
      case 'title':
        return s.matcher === 'contains' ? expect(page).toHaveTitle(new RegExp(reEsc(expected ?? ''))) : expect(page).toHaveTitle(expected ?? '');
      case 'save': {
        let raw: string;
        if (ref) {
          const loc = await el();
          const tag = await loc.evaluate((n) => n.tagName.toLowerCase());
          raw = ['input', 'textarea', 'select'].includes(tag) ? await loc.inputValue() : ((await loc.textContent()) ?? '').trim();
        } else raw = page.url();
        let value = raw;
        if (s.pattern) {
          const m = new RegExp(s.pattern).exec(raw);
          if (!m) throw new Error(`Save "${s.as}": pattern /${s.pattern}/ did not match "${raw}"`);
          value = m[1] ?? m[0];
        }
        (ctx.vars ??= {})[s.as!] = value;
        test.info().annotations.push({ type: 'runtime-value', description: `${s.as} = ${value}` });
        return;
      }
    }
  };

  const kind = spec.kind;
  const fn = kind === 'Navigate' ? step.navigate : kind === 'Data entry' ? step.enter : kind === 'Click' ? step.click : step.verify;
  await fn(label, async () => { await body(); }, page);
}

const splitList = (v?: string) => (v ?? '').split(/\s*[,،]\s*/).filter((x) => x !== '');

/** the input of a radio/checkbox group whose label (or value) is `option` */
async function optionIn(group: import('@playwright/test').Locator, option: string) {
  const idx = await group.evaluateAll((els, opt) => {
    const norm = (t: string | null | undefined) => (t ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const labelOf = (e: Element) => norm((e as HTMLInputElement).labels?.[0]?.textContent ?? e.closest('label')?.textContent ?? e.getAttribute('aria-label'));
    const want = norm(opt);
    return els.findIndex((e) => labelOf(e) === want || norm((e as HTMLInputElement).value) === want);
  }, option);
  if (idx < 0) throw new Error(`Option "${option}" not found in this group`);
  return group.nth(idx);
}

async function checkedLabels(loc: import('@playwright/test').Locator, control: string) {
  return loc.evaluateAll((els, ctl) => {
    if (ctl === 'checkbox') return (els[0] as HTMLInputElement)?.checked ? 'checked' : 'unchecked';
    return els.filter((e) => (e as HTMLInputElement).checked)
      .map((e) => ((e as HTMLInputElement).labels?.[0]?.textContent ?? e.closest('label')?.textContent ?? (e as HTMLInputElement).value).trim().replace(/\s+/g, ' '))
      .join(', ');
  }, control);
}

function defaultTitle(s: Step, target: string, value: string, expected?: string): string {
  switch (s.action) {
    case 'open': return `Open ${s.page} page`;
    case 'goto': return `Go to ${s.url}`;
    case 'fill': return `${target} = ${value}`;
    case 'select': return `Select ${value} in ${target}`;
    case 'choose': return `Choose ${value} in ${target}`;
    case 'check': case 'uncheck': return `${s.action === 'check' ? 'Tick' : 'Untick'} ${s.value ? value + ' in ' : ''}${target}`;
    case 'press': return `Press ${value}${target ? ` in ${target}` : ''}`;
    case 'save': return `Save ${target || 'page URL'}${s.pattern ? ` /${s.pattern}/` : ''} as {{var.${s.as}}}`;
    case 'text': case 'value': case 'count': return `${target} ${s.action} ${s.matcher} "${expected}"`;
    case 'url': case 'title': return `Page ${s.action} ${s.matcher} "${expected}"`;
    case 'link': return `Link ${target} ${s.matcher === 'equals' ? 'goes to' : 'points to'} "${expected}" and answers`;
    default: return `${ACTIONS[s.action].label}: ${target}`;
  }
}

/** a link: its address matches, and the address answers (no 4xx/5xx). mailto:/tel: links: address only. */
export async function checkLink(page: Page, loc: Locator, matcher: string | undefined, expected: string | undefined) {
  const href = await loc.evaluate((n) => (n as HTMLAnchorElement).href || n.getAttribute('href') || '');
  if (expected) {
    const want = new URL(expected, page.url()).toString();
    if (matcher === 'equals') expect(href, 'link address').toBe(want);
    else expect(href, 'link address').toContain(expected);
  }
  if (!/^https?:/i.test(href)) return;
  const res = await page.request.get(href, { failOnStatusCode: false, maxRedirects: 10, timeout: 20000 }).catch((e: Error) => e);
  if (res instanceof Error) throw new Error(`Link ${href} does not answer: ${res.message.split('\n')[0]}`);
  expect(res.status(), `link ${href} answers with HTTP ${res.status()}`).toBeLessThan(400);
}
