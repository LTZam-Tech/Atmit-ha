import { Injectable, Pipe, PipeTransform, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { AR } from './i18n-ar';

export type Lang = 'en' | 'ar';
const KEY = 'atimtha-lang';

/**
 * Runtime Arabic / English switch (backlog §2, §3). English text is the key; `i18n-ar.ts` holds the Arabic.
 * Switching sets <html lang dir>, so layouts built on logical CSS properties mirror for right-to-left.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly doc = inject(DOCUMENT);
  readonly lang = signal<Lang>(I18n.initial());

  constructor() {
    effect(() => {
      const l = this.lang();
      this.doc.documentElement.lang = l;
      this.doc.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
      try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
    });
  }

  private static initial(): Lang {
    try { const v = localStorage.getItem(KEY); if (v === 'en' || v === 'ar') return v; } catch { /* storage unavailable */ }
    return typeof navigator !== 'undefined' && navigator.language.startsWith('ar') ? 'ar' : 'en';
  }

  set(l: Lang) { this.lang.set(l); }

  /** t('Run {n} tests', { n: 3 }) */
  t(text: string, vars?: Record<string, string | number>): string {
    const s = this.lang() === 'ar' ? AR[text] ?? text : text;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s;
  }

  /** dates and numbers in the user's language (Arabic uses Arabic-Indic digits only where the locale does) */
  date(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(this.lang() === 'ar' ? 'ar-JO' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  }

  number(n: number | null | undefined): string {
    return n === null || n === undefined ? '—' : new Intl.NumberFormat(this.lang() === 'ar' ? 'ar-JO' : 'en-GB').format(n);
  }
}

/** {{ 'Projects' | t }} — impure so it follows the language signal */
@Pipe({ name: 't', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);
  transform(text: string, vars?: Record<string, string | number>): string {
    return this.i18n.t(text, vars);
  }
}
