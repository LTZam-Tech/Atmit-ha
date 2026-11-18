// Rule-based helpers for the Test builder — no AI, no network:
//   • which actions fit an element (from its kind)
//   • a valid value for a field (from its meaning, rules and options)
//   • negative / boundary rows (Equivalence Partitioning, Boundary Value Analysis, required, format, security)
//   • steps generated from a page's fields
//   • CSV import / export of the data table

export const SUGGEST = {
  textbox: ['fill', 'clear', 'press', 'value', 'visible', 'hidden', 'enabled', 'disabled', 'save'],
  datepicker: ['fill', 'value', 'visible', 'enabled', 'disabled', 'save'],
  textarea: ['fill', 'clear', 'value', 'visible', 'hidden', 'enabled', 'disabled', 'save'],
  password: ['fill', 'clear', 'press', 'visible', 'hidden'],
  select: ['select', 'value', 'visible', 'enabled', 'disabled', 'save'],
  radiogroup: ['choose', 'value', 'visible'],
  checkgroup: ['check', 'uncheck', 'value', 'visible'],
  checkbox: ['check', 'uncheck', 'value', 'visible', 'enabled', 'disabled'],
  button: ['click', 'dblclick', 'hover', 'visible', 'hidden', 'enabled', 'disabled', 'text'],
  link: ['click', 'link', 'hover', 'visible', 'hidden', 'text'],
  tab: ['click', 'visible', 'text'],
  heading: ['visible', 'text', 'hidden', 'save', 'click'],
  alert: ['text', 'visible', 'hidden', 'save'],
  dialog: ['visible', 'text', 'hidden', 'save'],
  picker: ['click', 'visible', 'hidden'],
  option: ['click', 'visible', 'hidden', 'text'],
  other: ['visible', 'click', 'text', 'hidden', 'save', 'count'],
};
export const suggestedActions = (control) => SUGGEST[control] ?? SUGGEST.other;
export const isInput = (c) => ['textbox', 'textarea', 'password', 'datepicker', 'select', 'radiogroup', 'checkgroup', 'checkbox'].includes(c);
const isText = (c) => ['textbox', 'textarea', 'password', undefined, ''].includes(c);

const SEMANTIC_VALUE = {
  email: '{{faker.internet.email}}',
  phone: '05{{faker.string.numeric(8)}}',
  fullName: '{{faker.person.fullName}}',
  firstName: '{{faker.person.firstName}}',
  lastName: '{{faker.person.lastName}}',
  username: '{{faker.internet.username}}',
  password: '{{faker.internet.password}}',
  date: '{{date.today}}',
  amount: '{{faker.number.int(1000)}}',
  quantity: '{{faker.number.int(10)}}',
  number: '{{faker.number.int(100)}}',
  nationalId: '1{{faker.string.numeric(9)}}',
  postalCode: '{{faker.location.zipCode}}',
  city: '{{faker.location.city}}',
  address: '{{faker.location.streetAddress}}',
  url: '{{faker.internet.url}}',
  otp: '{{faker.string.numeric(6)}}',
  description: '{{faker.lorem.sentence}}',
  search: '{{faker.lorem.word}}',
};

/** a value that should pass the field's rules */
export function validValue(def = {}) {
  const r = def.rules ?? {};
  if (def.options?.length) return def.options[0];
  if (def.control === 'checkbox') return '';
  if (def.control === 'datepicker' || def.semantic === 'date') return def.format ? `{{date.today(${def.format})}}` : '{{date.today}}';
  const num = (v) => (v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v));
  const min = num(r.min), max = num(r.max);
  if (min !== undefined || max !== undefined || def.semantic === 'age') {
    const lo = min ?? (def.semantic === 'age' ? 18 : 0), hi = max ?? (def.semantic === 'age' ? 99 : lo + 100);
    return String(Math.round((lo + hi) / 2));
  }
  let v = SEMANTIC_VALUE[def.semantic] ?? '{{faker.lorem.words(2)}}';
  if (r.maxlength && r.maxlength < 25 && !SEMANTIC_VALUE[def.semantic]) v = `{{faker.string.alpha(${Math.max(1, Math.min(r.maxlength, 10))})}}`;
  return v;
}

const INVALID_FORMAT = {
  email: [['not-an-email', 'email without @'], ['user@domain', 'email without domain suffix']],
  phone: [['abc12345', 'letters in mobile number'], ['12', 'mobile number too short']],
  date: [['31/02/2026', 'impossible date'], ['abc', 'text instead of a date']],
  nationalId: [['12AB', 'letters in national id']],
  url: [['not a url', 'text instead of a URL']],
  // number fields: browsers refuse letters in <input type=number>, so only the boundaries apply (BVA)
};

/**
 * Candidate rows for one field. Each: { field, value, type, technique, why, checked }
 * `checked` = suggested by default (security / special-character rows are offered but not ticked,
 * because whether the app must reject them depends on the requirement).
 */
export function fieldCases(field, def = {}) {
  const r = def.rules ?? {};
  const out = [];
  const add = (value, type, technique, why, checked = true) => out.push({ field, value: String(value), type, technique, why, checked });
  if (isText(def.control) || def.control === 'select') {
    if (r.required && isText(def.control)) add('', 'negative', 'Required', `${field} left empty`);
  }
  if (isText(def.control)) {
    if (r.maxlength) {
      // keep the value meaningful at the boundary (an email stays an email)
      const ofLen = (n) => def.semantic === 'email' && n > 13 ? 'a'.repeat(n - 12) + '@example.com' : def.semantic === 'phone' ? '0'.repeat(n) : `{{negative.longText(${n})}}`;
      add(ofLen(r.maxlength), 'positive', 'BVA', `${field} at the maximum length (${r.maxlength})`);
      // the max length comes from the page's maxlength attribute: the browser itself stops the extra character,
      // so the form must still save (if the limit is only checked by the server, switch this row to negative)
      add(ofLen(r.maxlength + 1), 'positive', 'BVA', `${field} typed one character over the maximum (${r.maxlength + 1}) — the field keeps only ${r.maxlength}`);
    }
    if (r.minlength) {
      add(`{{negative.longText(${r.minlength})}}`, 'positive', 'BVA', `${field} at the minimum length (${r.minlength})`);
      if (r.minlength > 1) add(`{{negative.longText(${r.minlength - 1})}}`, 'negative', 'BVA', `${field} one character under the minimum`);
    }
    const n = (v) => (v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v));
    const min = n(r.min), max = n(r.max);
    if (min !== undefined) { add(min, 'positive', 'BVA', `${field} at the minimum (${min})`); add(min - 1, 'negative', 'BVA', `${field} below the minimum (${min - 1})`); }
    if (max !== undefined) { add(max, 'positive', 'BVA', `${field} at the maximum (${max})`); add(max + 1, 'negative', 'BVA', `${field} above the maximum (${max + 1})`); }
    // free-text dates only: date pickers / <input type=date> can't even receive these, so they are offered, not ticked
    for (const [v, why] of INVALID_FORMAT[def.semantic] ?? []) add(v, 'negative', 'EP', why, def.semantic !== 'date');
    if (r.pattern && !INVALID_FORMAT[def.semantic]) add('@@@', 'negative', 'EP', `${field} does not match the required pattern`);
    const isNumber = ['age', 'amount', 'quantity', 'number'].includes(def.semantic) || (min !== undefined || max !== undefined);
    if (def.control !== 'password' && !isNumber) { // number fields refuse letters, so text attacks can't even be typed
      add('{{negative.sqlInjection}}', 'negative', 'Security', `SQL injection in ${field}`, false);
      add('{{negative.xss}}', 'negative', 'Security', `script (XSS) in ${field}`, false);
      add('{{negative.specialChars}}', 'negative', 'EP', `special characters in ${field}`, false);
      add('{{negative.arabic}}', 'positive', 'EP', `Arabic text in ${field}`, false);
    }
  }
  if (def.control === 'datepicker') {
    const f = def.format ? `, ${def.format}` : '';
    if (r.required) add('', 'negative', 'Required', `${field} left empty`);
    add(`{{date.plusDays(1${f})}}`, 'positive', 'EP', `${field} = tomorrow`, false);
    add(`{{date.plusDays(-1${f})}}`, 'positive', 'EP', `${field} = yesterday (switch to negative if past dates are not allowed)`, false);
  }
  if (def.options?.length > 1 && (def.control === 'select' || def.control === 'radiogroup')) {
    for (const o of def.options.slice(1)) add(o, 'positive', 'EP', `${field} = ${o} (each option)`, false);
  }
  return out;
}

/** steps + outcomes + one valid row from a page's fields (a form test in one click) */
export function stepsFromPage(page) {
  const els = page.elements;
  const steps = [], row = { id: 'TC-001', title: `${page.page} — valid data`, type: 'positive' };
  for (const e of els) {
    const c = e.def.control;
    if (!isInput(c) || e.params.length) continue;
    const ref = `${page.page}.${e.name}`;
    if (c === 'checkbox') { steps.push({ action: 'check', element: ref }); continue; }
    if (c === 'checkgroup') { steps.push({ action: 'check', element: ref, value: e.def.options?.[0] ?? '' }); continue; }
    steps.push({ action: c === 'select' ? 'select' : c === 'radiogroup' ? 'choose' : 'fill', element: ref, value: `{{data.${e.name}}}` });
    row[e.name] = validValue(e.def);
  }
  // the form's submit button — never logout / cancel / back
  const buttons = els.filter((e) => e.def.control === 'button' && !/log\s?out|sign\s?out|cancel|back|close|reset|delete|remove|خروج|إلغاء|رجوع|حذف/i.test(e.name + ' ' + JSON.stringify(e.def.name ?? '')));
  const label = (e) => e.name + ' ' + JSON.stringify(e.def.name ?? '');
  const submit = ['save|حفظ', 'submit|send|إرسال', 'create|add|register|confirm|إنشاء|إضافة|تأكيد', 'sign\s?in|log\s?in|دخول', 'next|continue|التالي|متابعة']
    .map((k) => buttons.find((e) => new RegExp(k, 'i').test(label(e)))).find(Boolean) ?? buttons.at(-1);
  if (submit) steps.push({ action: 'click', element: `${page.page}.${submit.name}` });
  const okEl = els.find((e) => /saved|success|done|confirm|thank|placed|created|submitted|sent|complete|ok\b|تم/i.test(e.name));
  const errEl = errorElement(els, okEl);
  const outcomes = [
    { name: 'success', steps: okEl ? [{ action: 'visible', element: `${page.page}.${okEl.name}` }] : errEl ? [{ action: 'hidden', element: `${page.page}.${errEl.name}` }] : [] },
    { name: 'error', steps: errEl ? errorChecks(page, els, errEl) : [] },
  ];
  return { steps, outcomes, row };
}

/** the element that shows the page's error: a message / dialog seen with an error, else any alert, else a name that says so */
export function errorElement(els, okEl) {
  const msg = (e) => ['alert', 'dialog'].includes(e.def.control) && e !== okEl;
  const bad = /error|fail|invalid|danger|wrong|خطأ|فشل/i;
  return els.find((e) => msg(e) && (bad.test(e.name) || (e.def.messages ?? []).some((m) => bad.test(m) || /not a valid|required|incorrect|مطلوب|غير صحيح/i.test(m))))
    ?? els.find(msg) ?? els.find((e) => /error|invalid|alert|خطأ/i.test(e.name));
}
/** check the error is shown; a dialog is closed afterwards so the page is usable again */
export function errorChecks(page, els, errEl) {
  const close = els.find((e) => e.name === `${errEl.name}Close`);
  return [{ action: 'visible', element: `${page.page}.${errEl.name}` }, ...(close ? [{ action: 'click', element: `${page.page}.${close.name}` }] : [])];
}

// ------------------------------------------------------------------ CSV (opens in Excel; UTF-8 with BOM keeps Arabic)
export function toCSV(rows, fields) {
  const cols = ['id', 'title', 'type', 'outcome', ...fields];
  const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
}

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? '']).filter(([h]) => h)));
}
