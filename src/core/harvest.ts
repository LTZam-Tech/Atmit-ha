/**
 * Harvest engine — collects the interactive elements of an open page and proposes, for each,
 * the best UNIQUE locator as primary plus the next ones as fallbacks.
 * Used by the OR Harvester script and the Setup Wizard. No dependency on the run environment.
 */
import type { Page } from '@playwright/test';
import { fromJQueryFormat } from '../utils/dates';

export interface Box { x: number; y: number; w: number; h: number }
export interface RawElement {
  tag: string; type: string; role: string; name: string; testid?: string; id?: string; label?: string;
  placeholder?: string; text?: string; css: string; xpath: string; hint: string; inForm: boolean; formIndex: number;
  attrName?: string; autocomplete?: string; required: boolean; maxlength?: number; minlength?: number;
  min?: string; max?: string; pattern?: string; inputmode?: string; box: Box;
  options?: string[];       // <select> option labels
  readonly?: boolean;
  datepicker?: boolean;     // jQuery UI / bootstrap / flatpickr… or <input type=date>
  dateFormat?: string;      // format the page expects (our tokens: dd/MM/yyyy)
  value?: string;           // radio / checkbox value attribute
  groupLabel?: string;      // fieldset legend / radiogroup label around a radio or checkbox
  href?: string;            // link target (absolute)
  newTab?: boolean;         // link opens a new tab / window
  message?: 'alert' | 'dialog'; // a message container (toast, alert box, modal) — located by its kind, not its text
  title?: string;           // dialog title
  msgCss?: string;          // stable selector of a message container (its kind classes + :visible)
  pointer?: boolean;        // the mouse turns into a hand over it — something to click
}
export type Candidate = Record<string, unknown>;
export interface Harvested { name: string; def: Candidate; meta: RawElement }

export async function harvestPage(page: Page, testIdAttr: string, limit = 80): Promise<Harvested[]> {
  // tsx/esbuild may inject __name() helpers into functions sent to the browser
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  await page.evaluate(`window.__atimthaMSG = ${JSON.stringify(MESSAGE_SELECTOR)}; window.__atimthaDLG = ${JSON.stringify(DIALOG_SELECTOR)}`);
  const raw: RawElement[] = await page.evaluate((attr) => {
    const MSG = (window as unknown as { __atimthaMSG: string }).__atimthaMSG;
    const DIALOG_SEL = (window as unknown as { __atimthaDLG: string }).__atimthaDLG;
    const SEL = 'input:not([type=hidden]),select,textarea,button,a[href],[role=button],[role=link],[role=tab],[role=checkbox],[role=option],[role=menuitem],[role=menuitemradio],[role=treeitem],[role=alert],h1,h2,h3,[' + attr + '],' + MSG;
    const visible = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute('role'); if (explicit) return explicit;
      const t = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'button' || (t === 'input' && ['submit', 'button', 'reset'].includes(type))) return 'button';
      if (t === 'a') return 'link';
      if (t === 'select') return 'combobox';
      if (t === 'textarea' || (t === 'input' && ['', 'text', 'email', 'search', 'tel', 'url', 'number'].includes(type))) return 'textbox';
      if (t === 'input' && type === 'checkbox') return 'checkbox';
      if (t === 'input' && type === 'radio') return 'radio';
      if (/^h[1-6]$/.test(t)) return 'heading';
      return '';
    };
    const labelOf = (el: Element) => {
      const id = el.getAttribute('id');
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const wrap = el.closest('label');
      return (byFor?.textContent || wrap?.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    };
    const xpathOf = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
        const sib = [...(n.parentElement?.children ?? [])].filter((s) => s.tagName === n!.tagName);
        parts.unshift(n.tagName.toLowerCase() + (sib.length > 1 ? `[${sib.indexOf(n) + 1}]` : ''));
      }
      return '//body/' + parts.join('/');
    };
    const cssOf = (el: Element) => {
      const t = el.tagName.toLowerCase();
      const name = el.getAttribute('name'); if (name) return `${t}[name="${name}"]`;
      const type = el.getAttribute('type'); const cls = [...el.classList].filter((c) => !/\d{3,}|^(active|hover|focus)/.test(c)).slice(0, 2);
      return t + (type ? `[type="${type}"]` : '') + cls.map((c) => '.' + CSS.escape(c)).join('');
    };
    const forms = [...document.querySelectorAll('form')];
    const seen = new Set<Element>();
    return [...document.querySelectorAll(SEL)].filter((el) => !seen.has(el) && seen.add(el) && (visible(el) || el.hasAttribute(attr)) && !/captcha/i.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.className}`)).map((el) => {
      const text = ((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const label = labelOf(el);
      const id = el.getAttribute('id') || undefined;
      const form = el.closest('form');
      const msgKind = el.matches(MSG) && !el.matches('input,select,textarea,button,a') ? (el.matches(DIALOG_SEL) ? 'dialog' : 'alert') : undefined;
      const dlgTitle = msgKind === 'dialog' ? (el.querySelector('.modal-title,.modal-header,[class*=title],h1,h2,h3,h4,h5,header') as HTMLElement | null)?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 40) : undefined;
      const msgText = msgKind ? ((el.querySelector('.modal-body,[class*=body],[class*=content] p,[class*=message],[class*=text]') as HTMLElement | null)?.innerText || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160) : undefined;
      const a = el.tagName === 'A' ? (el as HTMLAnchorElement) : null;
      return {
        message: msgKind, title: dlgTitle || undefined,
        pointer: getComputedStyle(el).cursor === 'pointer' || el.hasAttribute('onclick') || undefined,
        msgCss: msgKind ? (() => {
          const role = el.getAttribute('role');
          const cls = [...el.classList].filter((c) => /^(modal|modal-dialog|modal-content|toast|alert|notification|snackbar|swal2-popup|bootbox|ui-dialog|invalid-feedback|error-message|field-error|text-danger)$|(error|danger|fail|success|warn|info)/i.test(c) && !/\d{3,}/.test(c));
          return (cls.length ? cls.map((c) => '.' + CSS.escape(c)).join('') : role ? `[role="${role}"]` : el.tagName.toLowerCase()) + ':visible';
        })() : undefined,
        href: a && a.getAttribute('href') && !/^(javascript:|#$)/i.test(a.getAttribute('href') || '') ? a.href : undefined,
        newTab: a ? a.target === '_blank' || undefined : undefined,
        tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), role: roleOf(el),
        name: label || text || el.getAttribute('title') || el.getAttribute('placeholder') || '',
        testid: el.getAttribute(attr) || undefined,
        id: id && !/\d{4,}|[a-f0-9]{8,}|^:r/.test(id) ? id : undefined, // skip generated ids
        label: label || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        text: text || undefined,
        css: cssOf(el), xpath: xpathOf(el),
        hint: el.getAttribute(attr) || el.getAttribute('name') || id || (msgKind ? `${dlgTitle || ([...el.classList].find((c) => /error|danger|fail|success|warn|info/i.test(c)) ?? '').replace(/^(alert|toast|text|bg)-/, '')} ${msgKind === 'dialog' ? 'dialog' : 'message'}` : '') || label || el.getAttribute('placeholder') || text || el.tagName.toLowerCase(),
        ...(msgKind ? { text: msgText, name: msgText || '' } : {}),
        inForm: !!form, formIndex: form ? forms.indexOf(form) : -1,
        attrName: el.getAttribute('name') || undefined, autocomplete: el.getAttribute('autocomplete') || undefined,
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        maxlength: (el as HTMLInputElement).maxLength > 0 ? (el as HTMLInputElement).maxLength : undefined,
        minlength: (el as HTMLInputElement).minLength > 0 ? (el as HTMLInputElement).minLength : undefined,
        min: el.getAttribute('min') || undefined, max: el.getAttribute('max') || undefined,
        pattern: el.getAttribute('pattern') || undefined, inputmode: el.getAttribute('inputmode') || undefined,
        box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        options: el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].map((o) => o.text.trim()).filter((t) => t && !/^[-—–]+\s*(choose|select|اختر).*$/i.test(t) && !/^[-—–\s]*$/.test(t)).slice(0, 60) : undefined,
        value: (el as HTMLInputElement).type === 'radio' || (el as HTMLInputElement).type === 'checkbox' ? (el as HTMLInputElement).value : undefined,
        readonly: el.hasAttribute('readonly') || undefined,
        datepicker: (el as HTMLInputElement).type === 'date' || /hasDatepicker|datepicker|flatpickr|date-?picker|mat-datepicker/i.test(el.className + ' ' + (el.getAttribute('data-provide') ?? '') + ' ' + (el.getAttribute('data-toggle') ?? '')) || undefined,
        dateFormat: (() => {
          if ((el as HTMLInputElement).type === 'date') return 'yyyy-MM-dd';
          const jq = (window as unknown as { jQuery?: (e: Element) => { datepicker?: (a: string, b: string) => string } }).jQuery;
          try { const f = jq && el.classList.contains('hasDatepicker') ? jq(el).datepicker?.('option', 'dateFormat') : undefined; if (f) return 'jq:' + f; } catch { /* no jQuery UI */ }
          return el.getAttribute('data-date-format') || el.getAttribute('placeholder')?.match(/^[dmy]{1,4}[\/.-][dmy]{1,4}[\/.-][dmy]{1,4}$/i)?.[0] || undefined;
        })(),
        groupLabel: (() => {
          const g = el.closest('fieldset, [role=radiogroup], [role=group]');
          if (!g) return undefined;
          const lg = g.querySelector('legend');
          return ((lg && lg.textContent) || g.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') || undefined;
        })(),
      };
    });
  }, testIdAttr);

  const used = new Set<string>();
  const out: Harvested[] = [];
  // radios / checkboxes that share a name become ONE element with options (gender: Male | Female)
  const groups = new Map<string, RawElement[]>();
  for (const r of raw) if (r.tag === 'input' && (r.type === 'radio' || r.type === 'checkbox') && r.attrName) {
    const k = `${r.type}|${r.attrName}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const grouped = new Set<RawElement>();
  const groupItem = new Map<RawElement, Harvested>(); // first member → the group element (keeps page order)
  for (const [k, members] of groups) {
    const [type, name] = k.split('|');
    if (members.length < 2 && type === 'checkbox') continue; // a single checkbox stays a checkbox
    members.forEach((m) => grouped.add(m));
    const first = members[0];
    const label = first.groupLabel || name;
    const options = members.map((m) => (m.label || m.value || '').trim()).filter(Boolean);
    const box = members.reduce((b, m) => ({ x: Math.min(b.x, m.box.x), y: Math.min(b.y, m.box.y), w: 0, h: 0, r: Math.max(b.r, m.box.x + m.box.w), bt: Math.max(b.bt, m.box.y + m.box.h) }), { x: 1e9, y: 1e9, w: 0, h: 0, r: 0, bt: 0 });
    const meta: RawElement = { ...first, hint: label, name: label, label, options, box: { x: box.x, y: box.y, w: box.r - box.x, h: box.bt - box.y } };
    groupItem.set(first, {
      name: uniqueName(camel(label, type === 'radio' ? 'choice' : 'options'), used),
      def: { css: `input[type="${type}"][name="${name}"]`, control: type === 'radio' ? 'radiogroup' : 'checkgroup', options, ...(members.some((m) => m.required) ? { rules: { required: true } } : {}) },
      meta,
    });
  }
  // calendars, time slots, option lists drawn with buttons / cells → ONE element with a parameter
  const pickers = await findPickers(page, testIdAttr);
  const inPicker = new Set(pickers.flatMap((g) => g.members));
  const pickerAt = new Map(pickers.map((g) => [g.members[0], g]));
  const placed = new Set<PickerGroup>();
  const pickerItem = (g: PickerGroup): Harvested => ({ name: uniqueName(g.name, used), def: { css: g.css, ...(g.fallback ? { fallback: [{ css: g.fallback }] } : {}), control: 'picker', options: g.options, description: `${g.kind === 'day' ? 'Calendar day' : g.kind === 'time' ? 'Time slot' : 'Option'} — {${g.param}} is the text to pick` },
    meta: { tag: 'div', type: '', role: '', name: g.label, css: g.css, xpath: g.members[0], hint: g.name, inForm: false, formIndex: -1, required: false, box: g.box } });
  for (const r of raw.slice(0, limit * 2)) {
    const g = pickerAt.get(r.xpath);
    if (g) {
      placed.add(g);
      out.push(pickerItem(g));
      continue;
    }
    if (inPicker.has(r.xpath)) continue;
    if (groupItem.has(r)) { out.push(groupItem.get(r)!); continue; }
    if (grouped.has(r)) continue;
    let unique = await uniqueCandidates(page, r);
    if (r.message) unique = unique.filter((c) => !('text' in c) && !('name' in c));
    if (!unique.length) continue;
    const [primary, ...rest] = unique;
    const info = classify(r);
    const extra: Candidate = {};
    if (r.href) { const rel = relHref(r.href, page.url()); extra.href = rel; if (r.newTab) extra.newTab = true; }
    if (r.message && r.text) extra.messages = [r.text];
    // a message container that is also matched by an existing item (e.g. role=alert child) → keep one
    if (r.message && out.some((o) => o.meta.message && JSON.stringify(o.def).includes(JSON.stringify(primary).slice(1, -1)))) continue;
    const base = camel(r.hint, r.message === 'dialog' ? 'dialog' : r.role || r.tag);
    out.push({ name: uniqueName(r.role === 'heading' && used.has(base) ? `${base}Title` : base, used), def: { ...primary, ...(rest.length ? { fallback: rest.slice(0, 2) } : {}), ...info, ...extra }, meta: r });
    if (out.length >= limit) break;
  }
  // pickers made of cells / divs (not in the list above) go at the end
  for (const g of pickers) if (!placed.has(g)) out.push(pickerItem(g));
  return out;
}

export interface PickerGroup { name: string; label: string; kind: 'day' | 'time' | 'option'; param: string; css: string; global: string; options: string[]; members: string[]; box: Box; fallback?: string }

/**
 * Repeated clickable items that belong together — calendar days, time slots, guest counts, custom dropdown options —
 * often plain cells / divs with a click handler. Found by position in the same container, then located by their text:
 * `css: <container> <item>:text-is("{day}")` → used as `page.calendarDay(day=14)`.
 */
export async function findPickers(page: Page, attr: string): Promise<PickerGroup[]> {
  return page.evaluate((attr) => {
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
    const xpathOf = (el: Element): string => {
      const parts: string[] = [];
      for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
        const sib = [...(n.parentElement?.children ?? [])].filter((x) => x.tagName === n!.tagName);
        parts.unshift(n.tagName.toLowerCase() + (sib.length > 1 ? `[${sib.indexOf(n) + 1}]` : ''));
      }
      return '//body/' + parts.join('/');
    };
    // an item's label = its first line ("4:00 PM" of "4:00 PM\nIndoor")
    const textOf = (el: Element) => ((el as HTMLElement).innerText || '').trim().split(/\n/)[0].trim().replace(/\s+/g, ' ');
    const trigger = (el: Element) => el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded') || !!el.querySelector('[class*=chevron],[class*=caret],[class*=arrow-down],[class*=dropdown-icon]');
    const clickable = (el: Element) => {
      const t = el.tagName;
      if (t === 'BUTTON' || (t === 'A' && !el.getAttribute('href')) || /^(button|option|gridcell|menuitem|radio|tab)$/.test(el.getAttribute('role') || '')) return true;
      if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) return true;
      return getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
    };
    const disabled = (el: Element) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /\b(disabled|unavailable|past|inactive|is-disabled)\b/i.test(String((el as HTMLElement).className));
    const items = [...document.querySelectorAll('button,a,td,li,div,span,[role]')].filter((el) => {
      if (!visible(el) || !clickable(el) || trigger(el)) return false; // a dropdown's own button is a button, not a choice
      const t = textOf(el);
      if (!t || t.length > 25 || el.querySelector('input,select,textarea')) return false;
      return !el.querySelector('button,a,[role=button]') || el.tagName === 'BUTTON' || el.tagName === 'A';
    });
    const CONT = 'table,[role=grid],[role=listbox],[role=menu],[role=radiogroup],ul,ol,[class*=calendar],[class*=picker],[class*=slot],[class*=dropdown],[class*=menu],[class*=options],[class*=guests],[class*=times]';
    const groups = new Map<Element, Element[]>();
    for (const el of items) {
      const c = el.parentElement?.closest(CONT) ?? el.parentElement;
      if (!c) continue;
      groups.set(c, [...(groups.get(c) ?? []), el]);
    }
    const stable = (c: Element): string => {
      if (c.getAttribute(attr)) return `[${attr}="${c.getAttribute(attr)}"]`;
      if (c.id && !/\d{4,}|[a-f0-9]{8,}|^:r/.test(c.id)) return `#${CSS.escape(c.id)}`;
      const cls = [...c.classList].filter((x) => !/\d{3,}|^(active|open|show|hover|focus|selected|is-)/.test(x)).slice(0, 2);
      const own = c.tagName.toLowerCase() + cls.map((x) => '.' + CSS.escape(x)).join('');
      if (cls.length || ['TABLE', 'UL', 'OL'].includes(c.tagName)) return own;
      const parent = c.parentElement && c.parentElement !== document.body ? stable(c.parentElement) : '';
      return parent ? `${parent} > ${own}` : own;
    };
    const out: unknown[] = [];
    const usedEls = new Set<Element>();
    for (const [c, members0] of groups) {
      const tag = members0[0].tagName;
      const members = members0.filter((m) => m.tagName === tag && !usedEls.has(m));
      if (members.length < 3) continue;
      const texts = members.map(textOf);
      const day = texts.every((t) => /^\d{1,2}$/.test(t) && +t >= 1 && +t <= 31);
      const time = texts.every((t) => /^\d{1,2}[:.]\d{2}\s*(am|pm|ص|م)?$/i.test(t));
      const kind = day ? 'day' : time ? 'time' : 'option';
      if (kind === 'option' && new Set(texts).size < members.length * 0.8) continue; // repeated labels (e.g. "Add" ×10) are not a choice list
      if (kind === 'option') {
        // a real choice list looks alike: "1 guest, 2 guests…", "Indoor, Outdoor, Terrace" — not "2 guests, Wed Nov 4, 4:00 PM"
        const words = texts.map((t) => new Set(t.toLowerCase().replace(/[^a-z\u0600-\u06ff ]/g, ' ').split(/\s+/).filter((w) => w.length > 2)));
        const counts = new Map<string, number>();
        words.forEach((w) => w.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1)));
        const shared = [...counts.values()].some((n) => n >= texts.length * 0.6);
        const numbered = texts.filter((t) => /^\d/.test(t)).length >= texts.length * 0.8;
        const short = texts.every((t) => t.split(' ').length <= 3);
        if (!shared && !numbered && !(short && members.length >= 4 && ['LI', 'DIV', 'SPAN'].includes(tag) && !!c.closest('[role=listbox],[role=menu],ul,ol,[class*=dropdown],[class*=menu],[class*=options]'))) continue;
      }
      members.forEach((m) => usedEls.add(m));
      const role = members[0].getAttribute('role');
      const item = tag.toLowerCase() + (role ? `[role="${role}"]` : '');
      const param = kind;
      // days by their exact number ("1" must not match "10"); times / options by how their text starts ("4:00 PM" of "4:00 PM Indoor")
      const textSel = kind === 'day' ? `:text-is("{${param}}")` : `:text-matches("^\\\\s*{${param}}", "i")`;
      const css = `${stable(c)} ${item}${textSel}:not([disabled]):not([aria-disabled="true"]) >> nth=0`;
      const lbl = (c.getAttribute('aria-label') || '').trim();
      const ctid = (c.getAttribute(attr) || c.closest(`[${attr}]`)?.getAttribute(attr) || '').replace(/[-_]?(menu|list|listbox|options|dropdown)$/i, '');
      const name = kind === 'day' ? 'calendarDay' : kind === 'time' ? 'timeSlot' : (lbl || ctid || [...c.classList].find((x) => /guest|people|party|size|option|menu|dropdown|select/i.test(x)) || texts[0].replace(/[^a-zA-Z ]/g, '').trim().split(' ').slice(-1)[0] || 'choice') + ' option';
      const r = c.getBoundingClientRect();
      const global = `${item}${textSel}:visible:not([disabled]):not([aria-disabled="true"]) >> nth=0`;
      out.push({ name, label: lbl || name, kind, param, css, global, options: texts.filter((_, i) => !disabled(members[i])).slice(0, 62),
        members: members.map(xpathOf), box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } });
    }
    return out as never;
  }, attr).then(async (list: PickerGroup[]) => {
    // check each picker finds its first choice now; a container selector that misses → the page-wide one (visible items only)
    const out: PickerGroup[] = [];
    for (const g of list) {
      const first = (g.options[0] ?? '').replace(/["\\]/g, '');
      const finds = async (css: string) => (await page.locator(css.replace(`{${g.param}}`, first)).count().catch(() => 0)) > 0;
      if (first && !(await finds(g.css))) {
        if (!(await finds(g.global))) continue; // neither works — leave the items as separate elements
        out.push({ ...g, css: g.global, name: camel(g.name, 'choice') });
      } else out.push({ ...g, fallback: g.global, name: camel(g.name, 'choice') });
    }
    return out;
  });
}

/** Candidates in priority order, kept only if they match exactly ONE element */
export async function uniqueCandidates(page: Page, r: RawElement): Promise<Candidate[]> {
  const list: { def: Candidate; loc: ReturnType<Page['locator']> }[] = [];
  if (r.testid) list.push({ def: { testid: r.testid }, loc: page.getByTestId(r.testid) });
  if (r.role && r.name && r.role !== 'heading') list.push({ def: { role: r.role, name: r.name, exact: true }, loc: page.getByRole(r.role as 'button', { name: r.name, exact: true }) });
  if (r.label) list.push({ def: { label: r.label }, loc: page.getByLabel(r.label, { exact: true }) });
  if (r.placeholder) list.push({ def: { placeholder: r.placeholder }, loc: page.getByPlaceholder(r.placeholder, { exact: true }) });
  if (r.id) list.push({ def: { id: r.id }, loc: page.locator(`[id="${r.id}"]`) });
  if (r.msgCss) list.push({ def: { css: r.msgCss }, loc: page.locator(r.msgCss) });
  if (r.role === 'heading' && r.text) list.push({ def: { role: 'heading', name: r.text, exact: true }, loc: page.getByRole('heading', { name: r.text, exact: true }) });
  if (r.text && !['input', 'select', 'textarea'].includes(r.tag)) list.push({ def: { text: r.text, exact: true }, loc: page.getByText(r.text, { exact: true }) });
  list.push({ def: { css: r.css }, loc: page.locator(r.css) });
  list.push({ def: { xpath: r.xpath }, loc: page.locator(`xpath=${r.xpath}`) });

  const out: Candidate[] = [];
  for (const c of list) if ((await c.loc.count().catch(() => 0)) === 1) out.push(c.def);
  return out;
}

// ------------------------------------------------------------------ classification
export const CONTROLS = ['textbox', 'textarea', 'password', 'datepicker', 'select', 'checkbox', 'checkgroup', 'radiogroup', 'radio', 'file', 'button', 'link', 'heading', 'alert', 'dialog', 'picker', 'option', 'tab', 'other'] as const;

/** containers that show messages: alerts, toasts, notifications, inline field errors, modal dialogs */
export const DIALOG_SELECTOR = '[role=dialog],[role=alertdialog],.modal.show,.modal.in,.modal[style*="block"],.swal2-popup,.bootbox,.ui-dialog,.mat-dialog-container,.MuiDialog-paper,dialog[open]';
export const MESSAGE_SELECTOR = DIALOG_SELECTOR + ',[role=alert],[role=status],.toast,.toast-message,#toast-container>div,.alert,.notification,.noty_bar,.notyf__toast,.Toastify__toast,.snackbar,.mat-snack-bar-container,.invalid-feedback,.error-message,.field-error,.help-block.error,.validation-summary-errors,.text-danger';

/** same-origin link → its path (+ query, hash); other sites keep the full address */
export function relHref(href: string, base: string): string {
  try { const u = new URL(href, base), b = new URL(base); return u.origin === b.origin ? u.pathname + u.search + u.hash : u.toString(); } catch { return href; }
}
export const SEMANTICS: [string, RegExp][] = [
  ['email', /e-?mail|بريد/i],
  ['password', /pass(word)?|pwd|كلمة.?(ال)?(سر|مرور)/i],
  ['otp', /otp|one.?time|verification.?code|رمز.?التحقق/i],
  ['phone', /phone|mobile|tel\b|msisdn|جوال|هاتف|موبايل/i],
  ['nationalId', /national.?id|iqama|identity|id.?number|ssn|هوية|اقامة|إقامة|رقم.?وطني/i],
  ['username', /user.?name|login.?id|اسم.?المستخدم/i],
  ['firstName', /first.?name|given.?name|الاسم.?الأول/i],
  ['lastName', /last.?name|family.?name|surname|اسم.?العائلة/i],
  ['fullName', /full.?name|^name$|الاسم/i],
  ['date', /date|dob|birth|تاريخ/i],
  ['age', /\bage\b|عمر/i],
  ['country', /country|nationality|دولة|جنسية/i],
  ['gender', /gender|sex|الجنس/i],
  ['amount', /amount|price|cost|salary|total|مبلغ|سعر/i],
  ['quantity', /qty|quantity|count|عدد|كمية/i],
  ['search', /search|query|بحث/i],
  ['url', /url|website|link/i],
  ['postalCode', /zip|postal|postcode|رمز.?بريدي/i],
  ['city', /city|مدينة/i],
  ['address', /address|street|عنوان/i],
  ['description', /description|notes?|comment|remarks|about|bio|وصف|ملاحظات|نبذة/i],
];

/** control type, meaning and HTML rules of an element — feeds suggestions and negative-data generation */
export function classify(r: RawElement): { control?: string; semantic?: string; rules?: Record<string, unknown> } {
  const t = r.type;
  const control =
    r.tag === 'textarea' ? 'textarea' :
    r.tag === 'select' ? 'select' :
    r.tag === 'input' && t === 'password' ? 'password' :
    r.tag === 'input' && t === 'checkbox' ? 'checkbox' :
    r.tag === 'input' && t === 'radio' ? 'radio' :
    r.tag === 'input' && t === 'file' ? 'file' :
    r.message === 'dialog' ? 'dialog' :
    r.message === 'alert' ? 'alert' :
    r.datepicker ? 'datepicker' :
    r.role === 'button' ? 'button' :
    r.role === 'link' ? 'link' :
    r.role === 'heading' ? 'heading' :
    r.role === 'alert' || /error|alert|message|toast/i.test(r.hint) ? 'alert' :
    r.role === 'tab' ? 'tab' :
    ['option', 'menuitem', 'menuitemradio', 'treeitem'].includes(r.role) ? 'option' :
    r.tag === 'input' || r.role === 'textbox' ? 'textbox' : 'other';
  let semantic: string | undefined;
  if (control === 'datepicker') semantic = 'date';
  if (['textbox', 'textarea', 'password', 'select'].includes(control)) {
    const named = [r.attrName, r.label, r.placeholder, r.id, r.testid, r.autocomplete].filter(Boolean).join(' ');
    if (t === 'number' && /\bage\b|عمر/i.test(named)) semantic = 'age';
    else if (t === 'email') semantic = 'email';
    else if (t === 'tel') semantic = 'phone';
    else if (t === 'date' || t === 'datetime-local') semantic = 'date';
    else if (t === 'number') semantic = 'number';
    else if (t === 'url') semantic = 'url';
    else if (t === 'password') semantic = 'password';
    else {
      const text = [r.attrName, r.label, r.placeholder, r.id, r.testid, r.autocomplete].filter(Boolean).join(' ');
      semantic = SEMANTICS.find(([, re]) => re.test(text))?.[0];
    }
  }
  const rules: Record<string, unknown> = {};
  if (r.required) rules.required = true;
  if (r.maxlength && r.maxlength < 100000) rules.maxlength = r.maxlength;
  if (r.minlength) rules.minlength = r.minlength;
  if (r.min !== undefined) rules.min = isNaN(Number(r.min)) ? r.min : Number(r.min);
  if (r.max !== undefined) rules.max = isNaN(Number(r.max)) ? r.max : Number(r.max);
  if (r.pattern) rules.pattern = r.pattern;
  if (r.readonly) rules.readonly = true;
  const fmt = r.dateFormat ? (r.dateFormat.startsWith('jq:') ? fromJQueryFormat(r.dateFormat.slice(3)) : r.dateFormat.replace(/D/g, 'd').replace(/Y/g, 'y').replace(/m/g, 'M')) : undefined;
  return {
    ...(fmt ? { format: fmt } : {}), ...(control !== 'other' ? { control } : {}), ...(semantic ? { semantic } : {}), ...(Object.keys(rules).length ? { rules } : {}), ...(r.options?.length ? { options: r.options } : {}) };
}

/** Guess username / password / submit on a login page */
export function detectLoginFields(items: Harvested[]): { username?: string; password?: string; submit?: string } {
  const pwd = items.find((i) => i.meta.tag === 'input' && i.meta.type === 'password');
  if (!pwd) return {};
  const sameForm = (i: Harvested) => pwd.meta.formIndex === -1 || i.meta.formIndex === pwd.meta.formIndex;
  const idx = items.indexOf(pwd);
  const textInputs = items.filter((i, n) => n < idx && i.meta.tag === 'input' && ['', 'text', 'email', 'tel'].includes(i.meta.type) && sameForm(i));
  const user = textInputs.at(-1);
  const buttons = items.filter((i) => i.meta.role === 'button' && sameForm(i));
  const submit =
    buttons.find((b) => b.meta.type === 'submit') ??
    buttons.find((b) => /log\s?in|sign\s?in|submit|continue|دخول|تسجيل|متابعة/i.test(b.meta.name)) ??
    buttons.find((_, n) => items.indexOf(buttons[n]) > idx);
  return { username: user?.name, password: pwd.name, submit: submit?.name };
}

export function camel(s: string, fallback = 'element'): string {
  // split camelCase / PascalCase too (shipName → ship name) so the word boundaries survive
  const words = s.normalize('NFKD').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const latin = words.filter((w) => /^[a-z0-9]+$/i.test(w));
  const base = (latin.length ? latin : [fallback]).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return /^[a-z]/.test(base) ? base : 'el' + base;
}

export function uniqueName(name: string, used: Set<string>): string {
  let n = name, i = 2;
  while (used.has(n)) n = `${name}${i++}`;
  used.add(n);
  return n;
}

/** Best element to prove the page is loaded */
/** what an element looks like, to tell whether two pages show the same thing (header, nav…) */
export const itemSig = (i: Harvested) => `${i.meta.tag}|${i.meta.text ?? i.meta.name ?? ''}|${i.meta.css}`;

/**
 * Elements that prove a page is ready, best first: on screen when the page has loaded, never a message, and —
 * when `shared` is given (what the previous page showed) — not the header / menu that every page has.
 */
export function readyCandidates(items: Harvested[], shared: Set<string> = new Set()): string[] {
  const shown = items.filter((i) => (i.meta.box.w > 0 && i.meta.box.h > 0) && !['alert', 'dialog'].includes(String((i.def as { control?: string }).control)) && !/error|alert|message|saved|success|toast/i.test(i.name));
  const own = shown.filter((i) => !shared.has(itemSig(i)));
  const pageish = /title|header|heading|welcome|dashboard/i;
  const order = [
    ...own.filter((i) => i.meta.tag === 'h1'),
    ...own.filter((i) => i.meta.role === 'heading'),
    ...own.filter((i) => pageish.test(i.name)),
    ...own.filter((i) => 'testid' in i.def),
    ...own.filter((i) => ['input', 'select', 'textarea', 'button'].includes(i.meta.tag)),
    ...own,
    ...shown.filter((i) => /title|header|heading|welcome|dashboard|logo|brand|nav|menu|logout|profile/i.test(i.name)),
    ...shown.filter((i) => i.meta.tag === 'h1'),
    ...shown,
  ];
  return [...new Set(order.map((i) => i.name))];
}
export function pickReadyElement(items: Harvested[], shared?: Set<string>): string | undefined {
  return readyCandidates(items, shared)[0] ?? items[0]?.name;
}

// ------------------------------------------------------------------ messages that come and go (toasts, alert boxes, modal dialogs)
export interface SeenMessage { kind: 'alert' | 'dialog'; text: string; title?: string; testid?: string; id?: string; css: string; close?: string; tone?: 'error' | 'success' | 'info' }

/**
 * Browser-side watcher (plain JS source): records every message container that appears (toasts, alert boxes,
 * modal dialogs), even when it disappears again. report=false → kept in window.__atimthaSeen (Explore);
 * report=true → sent to window.__atimthaReport() at once (test runs: survives navigation), and messages
 * already on screen when the page loads are ignored (they are part of the page, collected normally).
 */
export function watcherScript(attr: string, report: boolean): string {
  return `(() => {
  const MSG = ${JSON.stringify(MESSAGE_SELECTOR)}, DLG = ${JSON.stringify(DIALOG_SELECTOR)}, attr = ${JSON.stringify(attr)}, REPORT = ${report};
  const w = window;
  if (w.__atimthaStop) w.__atimthaStop();
  w.__atimthaSeen = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'; };
  const textOf = (el) => (el.innerText || '').trim().replace(/\\s+/g, ' ');
  const before = new Map();
  const snapshot = () => document.querySelectorAll(MSG).forEach((el) => { if (visible(el)) before.set(el, textOf(el)); });
  const done = new Map();
  const check = () => {
    if (!document.body) return;
    document.querySelectorAll(MSG).forEach((el) => {
      if (!visible(el)) return;
      const outer = el.parentElement && el.parentElement.closest(MSG);
      if (outer && visible(outer)) return;
      const all = textOf(el);
      if (!all || before.get(el) === all || done.get(el) === all) return;
      done.set(el, all);
      const dialog = el.matches(DLG);
      const tEl = dialog ? el.querySelector('.modal-title,.modal-header,[class*=title],h1,h2,h3,h4,h5,header') : null;
      const title = tEl && tEl.innerText ? tEl.innerText.trim().replace(/\\s+/g, ' ').slice(0, 40) : undefined;
      const bEl = dialog ? el.querySelector('.modal-body,[class*=body],[class*=content] p,[class*=message],[class*=text]') : null;
      const body = (bEl && bEl.innerText) || all;
      const role = el.getAttribute('role');
      const cls = [...el.classList].filter((c) => /^(modal|modal-dialog|modal-content|toast|alert|notification|snackbar|swal2-popup|bootbox|ui-dialog|invalid-feedback|error-message|field-error|text-danger)$|(error|danger|fail|success|warn|info)/i.test(c) && !/\\d{3,}/.test(c));
      const css = (cls.length ? cls.map((c) => '.' + CSS.escape(c)).join('') : role ? '[role="' + role + '"]' : el.tagName.toLowerCase()) + ':visible';
      const btn = dialog ? [...el.querySelectorAll('button,[role=button],a.btn,.close')].find((b) => /^(close|ok|okay|dismiss|cancel|×|✕|x|إغلاق|اغلاق|حسنا|حسناً|موافق)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim())) : undefined;
      const closeText = btn ? ((btn.innerText || '').trim() || btn.getAttribute('aria-label') || '') : '';
      const toneSrc = el.className + ' ' + (title || '') + ' ' + body;
      const m = {
        kind: dialog ? 'dialog' : 'alert', text: body.trim().replace(/\\s+/g, ' ').slice(0, 160), title,
        testid: el.getAttribute(attr) || undefined, id: el.id && !/\\d{4,}|[a-f0-9]{8,}/.test(el.id) ? el.id : undefined, css,
        close: btn ? (btn.getAttribute(attr) ? '[' + attr + '="' + btn.getAttribute(attr) + '"]' : css + ' ' + btn.tagName.toLowerCase() + ':has-text("' + closeText.replace(/"/g, '\\\\"') + '")') : undefined,
        tone: /error|danger|fail|invalid|wrong|incorrect|not a valid|required|خطأ|فشل|غير صحيح|مطلوب/i.test(toneSrc) ? 'error' : /success|saved|thank|created|placed|done|تم|نجاح/i.test(toneSrc) ? 'success' : 'info',
      };
      if (REPORT && typeof w.__atimthaReport === 'function') w.__atimthaReport(m).catch(() => {}); else w.__atimthaSeen.push(m);
    });
  };
  let mo, iv;
  const start = () => {
    mo = new MutationObserver(check);
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'] });
    iv = setInterval(check, 150);
  };
  w.__atimthaStop = () => { if (mo) mo.disconnect(); clearInterval(iv); };
  if (REPORT) {
    // test run: what is on screen when the page has loaded belongs to the page
    const go = () => setTimeout(() => { snapshot(); start(); }, 300);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
  } else { snapshot(); start(); }
})();`;
}

/** start recording every message container that appears from now on (even if it disappears again) */
export async function watchMessages(page: Page, testIdAttr: string): Promise<void> {
  await page.evaluate(watcherScript(testIdAttr, false)).catch(() => {});
}

/** stop recording and return the messages seen since watchMessages() (empty when the page navigated away) */
export async function collectMessages(page: Page, waitMs = 1200): Promise<SeenMessage[]> {
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const w = window as unknown as { __atimthaSeen?: unknown[]; __atimthaStop?: () => void };
    w.__atimthaStop?.();
    return (w.__atimthaSeen ?? []) as never;
  }).catch(() => []);
}

/** OR element definitions for seen messages: { name, def } — located by kind (testid / id / classes), never by text */
export function messageElements(seen: SeenMessage[], used: Set<string>): { name: string; def: Candidate; close?: { name: string; def: Candidate }; msg: SeenMessage }[] {
  const out: { name: string; def: Candidate; close?: { name: string; def: Candidate }; msg: SeenMessage }[] = [];
  for (const m of seen) {
    const loc: Candidate = m.testid ? { testid: m.testid } : m.id ? { id: m.id } : { css: m.css };
    const same = out.find((o) => JSON.stringify(o.def).startsWith(JSON.stringify(loc).slice(0, -1)));
    if (same) { const list = same.def.messages as string[]; if (!list.includes(m.text)) list.push(m.text); continue; }
    const base = m.kind === 'dialog' ? `${m.title || m.tone || ''} dialog` : `${m.tone === 'info' ? '' : m.tone} message`;
    const name = uniqueName(camel(base, m.kind === 'dialog' ? 'dialog' : 'message'), used);
    const def: Candidate = { ...loc, ...(m.testid || m.id ? { fallback: [{ css: m.css }] } : {}), control: m.kind, messages: [m.text] };
    const close = m.close ? { name: uniqueName(`${name}Close`, used), def: { css: m.close, control: 'button' } as Candidate } : undefined;
    out.push({ name, def, close, msg: m });
  }
  return out;
}
