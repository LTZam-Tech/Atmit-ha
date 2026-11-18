/** Date helpers — including Hijri (Umm al-Qura) for Saudi/GCC systems. */

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export const isoDate = (date = new Date()) => date.toISOString().slice(0, 10);

/** dd/MM/yyyy — common in regional UIs */
export const dmy = (date = new Date()) =>
  `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

/** Hijri date as shown in Arabic UIs, e.g. "٢٠ جمادى الأولى ١٤٤٨ هـ" */
export const hijri = (date = new Date(), locale = 'ar-SA') =>
  new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura`, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);

/** Hijri parts as numbers (latin digits) for comparing with input fields */
export const hijriParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { day: get('day'), month: get('month'), year: get('year') };
};

/**
 * Format a date with tokens: yyyy yy MM M dd d  (e.g. "MM/dd/yyyy", "yyyy-MM-dd", "d/M/yy").
 * Default dd/MM/yyyy.
 */
export function formatDate(date = new Date(), format = 'dd/MM/yyyy'): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()), yy: String(date.getFullYear()).slice(-2),
    MM: p2(date.getMonth() + 1), M: String(date.getMonth() + 1), dd: p2(date.getDate()), d: String(date.getDate()),
  };
  return format.replace(/yyyy|yy|MM|M|dd|d/g, (t) => map[t]);
}

/** jQuery UI datepicker format ("dd/mm/yy", "mm/dd/yy"…) → our tokens */
export function fromJQueryFormat(f: string): string {
  return f.replace(/yy|y|mm|m|dd|d/g, (t) => ({ yy: 'yyyy', y: 'yy', mm: 'MM', m: 'M', dd: 'dd', d: 'd' })[t]!);
}
