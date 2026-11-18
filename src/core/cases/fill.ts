/**
 * fill() that understands date pickers and read-only widgets:
 *   • <input type=date|month|time|datetime-local> get the format the browser requires (31/10/2026 → 2026-10-31)
 *   • read-only fields (jQuery UI / bootstrap / flatpickr pickers) get the value set like the widget sets it
 *   • after a picker field is filled its calendar is closed, so it can't cover the next fields
 */
import type { Locator } from '@playwright/test';

const NATIVE = ['date', 'datetime-local', 'month', 'week', 'time'];

/** any common date text → the value a native input needs; undefined when it is not a date */
export function toNative(value: string, type: string): string | undefined {
  const v = value.trim();
  const p2 = (n: string | number) => String(n).padStart(2, '0');
  if (type === 'time') { const m = /^(\d{1,2}):(\d{2})/.exec(v); return m ? `${p2(m[1])}:${m[2]}` : undefined; }
  let y: string | undefined, mo: string | undefined, d: string | undefined, time = '';
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ](\d{1,2}:\d{2}))?$/.exec(v);
  if (m) { [, y, mo, d] = m; time = m[4] ?? ''; }
  else if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:[T ](\d{1,2}:\d{2}))?$/.exec(v))) {
    const a = Number(m[1]), b = Number(m[2]);
    // 13/02/2026 is day first, 02/13/2026 is month first; when both fit, day first (regional default)
    [d, mo] = b > 12 && a <= 12 ? [m[2], m[1]] : [m[1], m[2]];
    y = m[3]; time = m[4] ?? '';
  } else return undefined;
  if (Number(mo) < 1 || Number(mo) > 12 || (d !== undefined && (Number(d) < 1 || Number(d) > 31))) return undefined;
  if (type === 'month') return `${y}-${p2(mo!)}`;
  if (d === undefined) return undefined;
  const date = `${y}-${p2(mo!)}-${p2(d)}`;
  if (type === 'datetime-local') return `${date}T${time ? time.padStart(5, '0') : '00:00'}`;
  return date;
}

export async function smartFill(loc: Locator, value: string): Promise<{ direct: boolean; converted?: string; picker: boolean }> {
  const info = await loc.evaluate((el) => {
    const i = el as HTMLInputElement;
    const cls = `${el.className} ${el.getAttribute('data-provide') ?? ''} ${el.getAttribute('data-toggle') ?? ''}`;
    return { type: (i.type || '').toLowerCase(), picker: /hasDatepicker|datepicker|flatpickr|date-?picker|timepicker/i.test(cls) };
  });
  const native = NATIVE.includes(info.type);
  let v = value, converted: string | undefined;
  if (native && v !== '') {
    const n = toNative(v, info.type);
    if (n === undefined) throw new Error(`"${v}" can't be entered in this ${info.type} field — the browser only accepts real dates (e.g. 2026-10-31 or {{date.today}})`);
    if (n !== v) converted = n;
    v = n;
  }
  const editable = await loc.isEditable().catch(() => false);
  if (editable) await loc.fill(v);
  else await setValueDirectly(loc, v);
  const picker = native || info.picker;
  if (picker) await closePicker(loc);
  return { direct: !editable, converted, picker };
}

/** sets a value on a read-only / widget-controlled input and fires the events a picker would fire */
export async function setValueDirectly(loc: Locator, value: string) {
  await loc.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter ? setter.call(input, v) : (input.value = v); // works with React / Angular bindings too
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const jq = (window as unknown as { jQuery?: (e: Element) => { trigger: (n: string) => void } }).jQuery;
    if (jq) try { jq(input).trigger('change'); } catch { /* not a jQuery widget */ }
  }, value);
}

/** closes an open calendar (Escape + the widget's own close) so it does not cover other fields */
export async function closePicker(loc: Locator) {
  await loc.press('Escape').catch(() => {});
  await loc.evaluate((el) => {
    const w = window as unknown as { jQuery?: (e: Element) => { datepicker?: (a: string) => void } };
    try { w.jQuery?.(el).datepicker?.('hide'); } catch { /* not jQuery UI / bootstrap */ }
    try { (el as unknown as { _flatpickr?: { close: () => void } })._flatpickr?.close(); } catch { /* not flatpickr */ }
    (el as HTMLElement).blur();
  }).catch(() => {});
}
