/**
 * Rule-based test data for the Test Builder — no AI, no network. Ported from the local panel (panel/app/datagen.js:
 * validValue, fieldCases); keep both in step. Values use the engine's placeholders, resolved at run time:
 *   {{faker.*}}, {{date.*}}  ← src/core/cases/template.ts
 *   {{negative.*}}           ← src/data/negative/values.ts
 * Techniques: Required, BVA (boundary values), EP (equivalence partitions: formats, options, Arabic text), Security.
 */

/** what a page element says about itself (page content: elements.<name>) */
export interface FieldDef {
  control?: string;
  semantic?: string;
  format?: string;
  options?: string[];
  rules?: { required?: boolean; maxlength?: number; minlength?: number; min?: number | string; max?: number | string; pattern?: string };
}

export type Technique = 'Required' | 'BVA' | 'EP' | 'Security';

/** one proposed data row for one field */
export interface FieldCase { field: string; value: string; type: 'positive' | 'negative'; technique: Technique; why: string; checked: boolean }

const isText = (c?: string) => c === undefined || ['textbox', 'textarea', 'password', ''].includes(c);
const num = (v: unknown) => (v === undefined || v === '' || v === null || isNaN(Number(v)) ? undefined : Number(v));

const SEMANTIC_VALUE: Record<string, string> = {
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
export function validValue(def: FieldDef = {}): string {
  const r = def.rules ?? {};
  if (def.options?.length) return def.options[0];
  if (def.control === 'checkbox') return '';
  if (def.control === 'datepicker' || def.semantic === 'date') return def.format ? `{{date.today(${def.format})}}` : '{{date.today}}';
  const min = num(r.min), max = num(r.max);
  if (min !== undefined || max !== undefined || def.semantic === 'age') {
    const lo = min ?? (def.semantic === 'age' ? 18 : 0), hi = max ?? (def.semantic === 'age' ? 99 : lo + 100);
    return String(Math.round((lo + hi) / 2));
  }
  let v = SEMANTIC_VALUE[def.semantic ?? ''] ?? '{{faker.lorem.words(2)}}';
  if (r.maxlength && r.maxlength < 25 && !SEMANTIC_VALUE[def.semantic ?? '']) v = `{{faker.string.alpha(${Math.max(1, Math.min(r.maxlength, 10))})}}`;
  return v;
}

const INVALID_FORMAT: Record<string, [string, string][]> = {
  email: [['not-an-email', 'email without @'], ['user@domain', 'email without domain suffix']],
  phone: [['abc12345', 'letters in mobile number'], ['12', 'mobile number too short']],
  date: [['31/02/2026', 'impossible date'], ['abc', 'text instead of a date']],
  nationalId: [['12AB', 'letters in national id']],
  url: [['not a url', 'text instead of a URL']],
  // number fields: browsers refuse letters in <input type=number>, so only the boundaries apply (BVA)
};

/**
 * Candidate rows for one field. `checked` = suggested by default: security and special-character rows are offered
 * but not ticked, because whether the application must refuse them depends on the requirement.
 */
export function fieldCases(field: string, def: FieldDef = {}): FieldCase[] {
  const r = def.rules ?? {};
  const out: FieldCase[] = [];
  const add = (value: unknown, type: FieldCase['type'], technique: Technique, why: string, checked = true) =>
    out.push({ field, value: String(value), type, technique, why, checked });
  if ((isText(def.control) || def.control === 'select') && r.required && isText(def.control)) add('', 'negative', 'Required', `${field} left empty`);
  if (isText(def.control)) {
    if (r.maxlength) {
      // keep the value meaningful at the boundary (an email stays an email)
      const ofLen = (n: number) => def.semantic === 'email' && n > 13 ? 'a'.repeat(n - 12) + '@example.com' : def.semantic === 'phone' ? '0'.repeat(n) : `{{negative.longText(${n})}}`;
      add(ofLen(r.maxlength), 'positive', 'BVA', `${field} at the maximum length (${r.maxlength})`);
      // the browser stops the extra character (maxlength attribute), so the form must still save;
      // if the limit is only checked by the server, switch this row to negative
      add(ofLen(r.maxlength + 1), 'positive', 'BVA', `${field} typed one character over the maximum (${r.maxlength + 1}) — the field keeps only ${r.maxlength}`);
    }
    if (r.minlength) {
      add(`{{negative.longText(${r.minlength})}}`, 'positive', 'BVA', `${field} at the minimum length (${r.minlength})`);
      if (r.minlength > 1) add(`{{negative.longText(${r.minlength - 1})}}`, 'negative', 'BVA', `${field} one character under the minimum`);
    }
    const min = num(r.min), max = num(r.max);
    if (min !== undefined) { add(min, 'positive', 'BVA', `${field} at the minimum (${min})`); add(min - 1, 'negative', 'BVA', `${field} below the minimum (${min - 1})`); }
    if (max !== undefined) { add(max, 'positive', 'BVA', `${field} at the maximum (${max})`); add(max + 1, 'negative', 'BVA', `${field} above the maximum (${max + 1})`); }
    // free-text dates only: date pickers cannot even receive these, so they are offered, not ticked
    for (const [v, why] of INVALID_FORMAT[def.semantic ?? ''] ?? []) add(v, 'negative', 'EP', why, def.semantic !== 'date');
    if (r.pattern && !INVALID_FORMAT[def.semantic ?? '']) add('@@@', 'negative', 'EP', `${field} does not match the required pattern`);
    const isNumber = ['age', 'amount', 'quantity', 'number'].includes(def.semantic ?? '') || min !== undefined || max !== undefined;
    if (def.control !== 'password' && !isNumber) { // number fields refuse letters, so text attacks cannot even be typed
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
  if ((def.options?.length ?? 0) > 1 && (def.control === 'select' || def.control === 'radiogroup')) {
    for (const o of def.options!.slice(1)) add(o, 'positive', 'EP', `${field} = ${o} (each option)`, false);
  }
  return out;
}

/** the element definition inside a page's content, or {} when the page or element is unknown */
export function fieldDefOf(pageContent: Record<string, unknown> | undefined, element: string): FieldDef {
  const els = pageContent?.['elements'];
  const def = els && typeof els === 'object' ? (els as Record<string, unknown>)[element] : undefined;
  return def && typeof def === 'object' ? (def as FieldDef) : {};
}
