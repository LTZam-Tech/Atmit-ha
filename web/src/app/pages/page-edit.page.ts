import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { Session } from '../core/session';
import { I18n, TranslatePipe } from '../core/i18n';
import { TabsKeyboard } from '../core/tabs.directive';
import type { PageSummary, TestUser } from '../core/models';
import { ErrorState } from '../core/states';

/** locator strategies the engine understands (src/core/or/types.ts; SnapshotImporter.StrategyKeys) */
const STRATEGIES = ['testid', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'id', 'css', 'xpath'] as const;
const LOCATOR_KEYS = new Set<string>([...STRATEGIES, 'name', 'exact']);
const EDITED_KEYS = new Set(['within', 'frame', 'nth', 'hasText', 'control', 'description', 'fallback']);

interface ElementRow {
  key: string;
  /** short = "username" (the page's default strategy); simple = one strategy + text; json = anything richer (role + name, bilingual text…) */
  mode: 'short' | 'simple' | 'json';
  strategy: string;
  value: string;
  json: string;
  within: string;
  frame: string;
  nth: string;
  hasText: string;
  control: string;
  description: string;
  fallbacks: string[];
  /** element keys the editor does not show (semantic, rules, format, options, href, newTab, messages): kept as they are */
  rest: Record<string, unknown>;
}

interface PageMeta { key: string; url: string; open: 'url' | 'navigate'; description: string; readyWhen: string; auth: string; tags: string; timeout: string; defaultStrategy: string }

/**
 * Object repository editor (backlog §3 Pages & Smart Object Repository): a page's elements, their locators and
 * fallbacks, as a table or as JSON, sent for review like a test case (ADR-0007). Elements keep their identity by name.
 */
@Component({
  selector: 'at-page-edit',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, TabsKeyboard, ErrorState],
  template: `
    <div class="at-row">
      <h1 class="at-grow">{{ (isNew() ? 'New page' : 'Page') | t }}
        @if (!isNew()) { <span class="mono at-muted">{{ pageKey() }}</span> }
        @if (version()) { <span class="at-badge">v{{ version() }}</span> }</h1>
      @if (isNew()) { <a class="at-btn" [routerLink]="['/projects', projectId()]">{{ 'Back' | t }}</a> }
      @else { <a class="at-btn" [routerLink]="['/projects', projectId(), 'pages', pageKey()]">{{ 'Back' | t }}</a> }
    </div>
    <at-error [message]="error()" />
    <p class="at-muted">{{ 'Elements used by test steps keep working: elements are matched by name. An element that steps still use cannot be removed.' | t }}</p>

    <nav class="at-tabs" role="tablist">
      <a href="#" role="tab" [class.active]="tab() === 'builder'" [attr.aria-selected]="tab() === 'builder'" (click)="$event.preventDefault(); showBuilder()">{{ 'Elements' | t }}</a>
      <a href="#" role="tab" [class.active]="tab() === 'json'" [attr.aria-selected]="tab() === 'json'" (click)="$event.preventDefault(); showJson()">JSON</a>
    </nav>

    @if (tab() === 'builder') {
      <section class="at-card at-stack">
        <div class="at-row wrap">
          @if (isNew()) {
            <div class="at-field"><label for="pk">{{ 'Key' | t }}</label><input id="pk" class="at-input mono" [(ngModel)]="meta.key" dir="ltr" placeholder="checkout"></div>
          }
          <div class="at-field at-grow"><label for="pu">{{ 'Address' | t }}</label><input id="pu" class="at-input mono" [(ngModel)]="meta.url" dir="ltr" placeholder="/checkout"></div>
          <div class="at-field"><label for="po">{{ 'Opens by' | t }}</label>
            <select id="po" class="at-select" [(ngModel)]="meta.open"><option value="url">{{ 'address' | t }}</option><option value="navigate">{{ 'navigation' | t }}</option></select></div>
          <div class="at-field"><label for="pa">{{ 'Signed in as' | t }}</label>
            <select id="pa" class="at-select" [(ngModel)]="meta.auth">
              <option value="">—</option><option value="none">{{ 'Signed out' | t }}</option>
              @for (u of users(); track u.key) { <option [value]="u.key">{{ u.key }}</option> }
            </select></div>
          <div class="at-field"><label for="pr">{{ 'Ready when' | t }}</label>
            <select id="pr" class="at-select" [(ngModel)]="meta.readyWhen">
              <option value="">—</option>
              @for (e of elements; track $index) { @if (e.key) { <option [value]="e.key">{{ e.key }}</option> } }
            </select></div>
        </div>
        <div class="at-row wrap">
          <div class="at-field at-grow"><label for="pd">{{ 'Description' | t }}</label><input id="pd" class="at-input" [(ngModel)]="meta.description"></div>
          <div class="at-field"><label for="pt">{{ 'Tags (comma separated)' | t }}</label><input id="pt" class="at-input mono" [(ngModel)]="meta.tags" dir="ltr"></div>
          <div class="at-field"><label for="ps">{{ 'Plain names are' | t }}</label>
            <select id="ps" class="at-select" [(ngModel)]="meta.defaultStrategy"><option value="testid">testid</option><option value="id">id</option><option value="css">css</option><option value="xpath">xpath</option></select></div>
          <div class="at-field"><label for="pw">{{ 'Wait (ms)' | t }}</label><input id="pw" class="at-input mono" type="number" min="0" [(ngModel)]="meta.timeout" dir="ltr"></div>
        </div>
      </section>

      <section class="at-card at-stack">
        <div class="at-row"><h2 class="at-grow">{{ 'Elements' | t }} ({{ i18n.number(elements.length) }})</h2>
          <button type="button" class="at-btn" (click)="addElement()">+ {{ 'Add element' | t }}</button></div>
        @for (e of elements; track $index; let i = $index) {
          <div class="element">
            <div class="at-row wrap">
              <input class="at-input mono key" [(ngModel)]="e.key" dir="ltr" [placeholder]="'name' | t" [attr.aria-label]="'Element' | t">
              @switch (e.mode) {
                @case ('short') {
                  <span class="at-badge mono">{{ meta.defaultStrategy }}</span>
                  <input class="at-input mono at-grow" [(ngModel)]="e.value" dir="ltr" [attr.aria-label]="'Locator' | t">
                  <button type="button" class="at-btn" (click)="toSimple(e)">{{ 'Other strategy' | t }}</button>
                }
                @case ('simple') {
                  <select class="at-select" [(ngModel)]="e.strategy" [attr.aria-label]="'Strategy' | t">@for (s of strategies; track s) { <option [value]="s">{{ s }}</option> }</select>
                  <input class="at-input mono at-grow" [(ngModel)]="e.value" dir="ltr" [attr.aria-label]="'Locator' | t">
                  <button type="button" class="at-btn" (click)="toJson(e)">JSON</button>
                }
                @default {
                  <input class="at-input mono at-grow" [(ngModel)]="e.json" dir="ltr" [attr.aria-label]="'Locator' | t" placeholder='{ "role": "button", "name": { "en": "Save", "ar": "حفظ" } }'>
                }
              }
              <span class="tools">
                <button type="button" class="at-btn icon" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move up' | t">↑</button>
                <button type="button" class="at-btn icon" [disabled]="i === elements.length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move down' | t">↓</button>
                <button type="button" class="at-btn icon danger" (click)="elements.splice(i, 1)" [attr.aria-label]="'Remove' | t">✕</button>
              </span>
            </div>
            <details>
              <summary class="at-muted">{{ 'More' | t }}@if (e.fallbacks.length) { · {{ 'Fallbacks' | t }}: {{ i18n.number(e.fallbacks.length) }} }</summary>
              <div class="at-row wrap">
                <div class="at-field"><label>{{ 'inside' | t }}</label>
                  <select class="at-select" [(ngModel)]="e.within"><option value="">—</option>
                    @for (o of elements; track $index) { @if (o !== e && o.key) { <option [value]="o.key">{{ o.key }}</option> } }</select></div>
                <div class="at-field"><label>frame</label><input class="at-input mono" [(ngModel)]="e.frame" dir="ltr"></div>
                <div class="at-field"><label>nth</label><input class="at-input mono small" type="number" min="0" [(ngModel)]="e.nth" dir="ltr"></div>
                <div class="at-field"><label>hasText</label><input class="at-input mono" [(ngModel)]="e.hasText" dir="ltr"></div>
                <div class="at-field"><label>{{ 'Control' | t }}</label><input class="at-input mono" [(ngModel)]="e.control" dir="ltr" placeholder="picker"></div>
                <div class="at-field at-grow"><label>{{ 'Description' | t }}</label><input class="at-input" [(ngModel)]="e.description"></div>
              </div>
              <div class="at-stack fallbacks">
                <b>{{ 'Fallbacks' | t }}</b> <span class="at-muted">{{ 'tried in order when the main locator finds nothing; a run that uses one is reported as healed' | t }}</span>
                @for (f of e.fallbacks; track $index; let fi = $index) {
                  <div class="at-row"><span class="num">{{ fi + 1 }}</span>
                    <input class="at-input mono at-grow" [(ngModel)]="e.fallbacks[fi]" dir="ltr" placeholder='{ "css": "button.save" }' [attr.aria-label]="'Fallback' | t">
                    <button type="button" class="at-btn icon danger" (click)="e.fallbacks.splice(fi, 1)" [attr.aria-label]="'Remove' | t">✕</button></div>
                }
                <div><button type="button" class="at-btn" (click)="e.fallbacks.push('')">+ {{ 'Add fallback' | t }}</button></div>
              </div>
            </details>
          </div>
        }
      </section>
    } @else {
      <div class="at-field">
        <label for="json">{{ 'Content (JSON, the page file as in 0.1.0)' | t }}</label>
        <textarea id="json" class="editor" dir="ltr" spellcheck="false" [(ngModel)]="jsonText"></textarea>
      </div>
    }

    <div class="at-row submit">
      <input class="at-input at-grow" [(ngModel)]="changeTitle" [placeholder]="'Describe the change' | t" [attr.aria-label]="'Describe the change' | t">
      @if (session.can('project.edit')) {
        <button type="button" class="at-btn primary" [disabled]="busy() || !changeTitle.trim()" (click)="submit()">{{ 'Send for review' | t }}</button>
      } @else { <span class="at-muted">{{ 'You can read this, but editing needs the project.edit permission.' | t }}</span> }
    </div>
  `,
  styles: [`
    section.at-card { margin-block: var(--at-space-4); }
    .wrap { flex-wrap: wrap; align-items: end; }
    .element { border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); padding: var(--at-space-2) var(--at-space-3); }
    .element details { margin-block-start: var(--at-space-2); }
    .key { inline-size: 180px; } .small { inline-size: 80px; }
    .tools { display: flex; gap: 2px; margin-inline-start: auto; } .icon { padding-inline: 8px; }
    .num { inline-size: 24px; text-align: center; color: var(--at-color-muted); }
    .fallbacks { margin-block-start: var(--at-space-2); }
    .editor { inline-size: 100%; min-block-size: 480px; font-family: var(--at-font-mono); font-size: 13px; padding: var(--at-space-3);
      border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); background: var(--at-color-surface); color: var(--at-color-text); }
    .submit { margin-block-start: var(--at-space-4); position: sticky; inset-block-end: 0; background: var(--at-color-bg); padding-block: var(--at-space-3); }
  `],
})
export class PageEditPage {
  readonly projectId = input.required<string>();
  /** absent on the "new page" route */
  readonly pageKey = input<string | undefined>(undefined);
  /** ?url=/path: a new page pre-filled from a run's findings */
  readonly url = input<string | undefined>(undefined);
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly i18n = inject(I18n);
  protected readonly isNew = computed(() => !this.pageKey());
  protected readonly version = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly tab = signal<'builder' | 'json'>('builder');
  protected readonly users = signal<TestUser[]>([]);
  private readonly pages = signal<PageSummary[]>([]);
  protected readonly strategies = STRATEGIES;

  protected meta: PageMeta = { key: '', url: '', open: 'url', description: '', readyWhen: '', auth: '', tags: '', timeout: '', defaultStrategy: 'testid' };
  protected elements: ElementRow[] = [];
  protected jsonText = '';
  protected changeTitle = '';
  private original: Record<string, unknown> = {};

  constructor() {
    effect(() => { void this.load(this.projectId(), this.pageKey()); });
  }

  private async load(projectId: string, key: string | undefined) {
    this.error.set(null);
    this.tab.set('builder');
    this.version.set(null);
    try {
      const [users, pages] = await Promise.all([firstValueFrom(this.api.testUsers(projectId)), firstValueFrom(this.api.pages(projectId))]);
      this.users.set(users);
      this.pages.set(pages);
    } catch { /* the user list only fills a dropdown */ }
    if (!key) {
      const url = this.url() ?? '';
      const suggested = url.split('/').filter(Boolean).pop()?.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')) ?? '';
      this.fromContent({ page: /^[a-zA-Z]/.test(suggested) ? suggested[0].toLowerCase() + suggested.slice(1) : '', url, elements: {} });
      return;
    }
    try {
      const c = await firstValueFrom(this.api.pageContent(projectId, key));
      this.version.set(c.version);
      this.fromContent(c.content);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected addElement() { this.elements.push(this.row('', '', this.meta.defaultStrategy)); }
  protected move(i: number, by: number) { const [e] = this.elements.splice(i, 1); this.elements.splice(i + by, 0, e); }
  protected toSimple(e: ElementRow) { e.mode = 'simple'; e.strategy = this.meta.defaultStrategy; }
  protected toJson(e: ElementRow) { e.json = JSON.stringify(e.value ? { [e.strategy]: e.value } : {}); e.mode = 'json'; }

  private row(key: string, node: unknown, defaultStrategy: string): ElementRow {
    const r: ElementRow = { key, mode: 'short', strategy: defaultStrategy, value: '', json: '', within: '', frame: '', nth: '', hasText: '', control: '', description: '', fallbacks: [], rest: {} };
    if (typeof node === 'string') { r.value = node; return r; }
    const o = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
    const locator = Object.fromEntries(Object.entries(o).filter(([k]) => LOCATOR_KEYS.has(k)));
    const keys = Object.keys(locator);
    if (keys.length === 1 && typeof locator[keys[0]] === 'string' && (STRATEGIES as readonly string[]).includes(keys[0])) {
      r.mode = 'simple'; r.strategy = keys[0]; r.value = locator[keys[0]] as string;
    } else {
      r.mode = 'json'; r.json = keys.length ? JSON.stringify(locator) : '';
    }
    const s = (k: string) => (o[k] === undefined || o[k] === null ? '' : typeof o[k] === 'string' ? (o[k] as string) : JSON.stringify(o[k]));
    r.within = s('within'); r.frame = s('frame'); r.nth = s('nth'); r.hasText = s('hasText'); r.control = s('control'); r.description = s('description');
    r.fallbacks = Array.isArray(o['fallback']) ? (o['fallback'] as unknown[]).map((f) => JSON.stringify(f)) : [];
    r.rest = Object.fromEntries(Object.entries(o).filter(([k]) => !LOCATOR_KEYS.has(k) && !EDITED_KEYS.has(k)));
    return r;
  }

  private fromContent(c: Record<string, unknown>) {
    this.original = structuredClone(c);
    const settings = (c['settings'] && typeof c['settings'] === 'object' ? c['settings'] : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
    this.meta = {
      key: this.pageKey() ?? s('page'), url: s('url'), open: c['open'] === 'navigate' ? 'navigate' : 'url', description: s('description'),
      readyWhen: s('readyWhen'), auth: s('auth'), tags: Array.isArray(c['tags']) ? (c['tags'] as string[]).join(', ') : '',
      timeout: settings['timeout'] === undefined ? '' : String(settings['timeout']),
      defaultStrategy: typeof settings['defaultStrategy'] === 'string' ? (settings['defaultStrategy'] as string) : 'testid',
    };
    const els = (c['elements'] && typeof c['elements'] === 'object' ? c['elements'] : {}) as Record<string, unknown>;
    this.elements = Object.entries(els).map(([k, v]) => this.row(k, v, this.meta.defaultStrategy));
  }

  private toContent(): Record<string, unknown> {
    const m = this.meta;
    const key = this.isNew() ? m.key.trim() : this.pageKey()!;
    const out: Record<string, unknown> = { ...this.original, page: key };
    const set = (k: string, v: unknown) => { if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) delete out[k]; else out[k] = v; };
    set('url', m.url.trim());
    set('open', m.open === 'navigate' ? 'navigate' : '');
    set('description', m.description.trim());
    set('readyWhen', m.readyWhen);
    set('auth', m.auth);
    set('tags', m.tags.split(',').map((t) => t.trim()).filter(Boolean));
    const settings = { ...((this.original['settings'] as Record<string, unknown>) ?? {}) };
    if (m.timeout.trim()) settings['timeout'] = Number(m.timeout); else delete settings['timeout'];
    if (m.defaultStrategy !== 'testid' || 'defaultStrategy' in settings) settings['defaultStrategy'] = m.defaultStrategy;
    set('settings', Object.keys(settings).length ? settings : '');

    const problems: string[] = [];
    const parse = (text: string, where: string): unknown => {
      try { return JSON.parse(text); } catch { problems.push(`${where}: ${this.i18n.t('write it as JSON, e.g. { "css": "button.save" }')}`); return undefined; }
    };
    const elements: Record<string, unknown> = {};
    for (const e of this.elements) {
      const k = e.key.trim();
      if (!/^[a-zA-Z][\w]*$/.test(k)) { problems.push(this.i18n.t('Element name "{name}": letters, digits and _, starting with a letter', { name: k })); continue; }
      if (k in elements) { problems.push(this.i18n.t('Element "{name}" appears twice', { name: k })); continue; }
      const extras: Record<string, unknown> = {};
      if (e.within) extras['within'] = e.within;
      if (e.frame.trim()) extras['frame'] = e.frame.trim();
      if (String(e.nth).trim() !== '') extras['nth'] = Number(e.nth);
      if (e.hasText.trim()) extras['hasText'] = e.hasText.trim().startsWith('{') ? parse(e.hasText, `${k}.hasText`) : e.hasText;
      if (e.control.trim()) extras['control'] = e.control.trim();
      if (e.description.trim()) extras['description'] = e.description.trim();
      const fallbacks = e.fallbacks.filter((f) => f.trim()).map((f, i) => parse(f, `${k} ${this.i18n.t('fallback')} ${i + 1}`));
      if (fallbacks.length) extras['fallback'] = fallbacks;
      const plain = !Object.keys(extras).length && !Object.keys(e.rest).length;

      if (e.mode === 'short' && plain) {
        if (!e.value.trim()) problems.push(this.i18n.t('Element "{name}" needs a locator', { name: k }));
        elements[k] = e.value.trim();
        continue;
      }
      let locator: unknown;
      if (e.mode === 'json') locator = e.json.trim() ? parse(e.json, k) : {};
      else locator = { [e.mode === 'short' ? m.defaultStrategy : e.strategy]: e.value.trim() };
      if (!locator || typeof locator !== 'object' || !Object.keys(locator as object).length) problems.push(this.i18n.t('Element "{name}" needs a locator', { name: k }));
      elements[k] = { ...(locator as object), ...extras, ...e.rest };
    }
    out['elements'] = elements;
    if (!key || !/^[a-zA-Z][\w]*$/.test(key)) problems.push(this.i18n.t('The page key uses letters, digits and _, starting with a letter.'));
    if (this.isNew() && this.pages().some((p) => p.key === key)) problems.push(this.i18n.t('A page with this key already exists.'));
    if (problems.length) throw new Error(problems.join('\n'));
    return out;
  }

  protected showJson() {
    try { this.jsonText = JSON.stringify(this.toContent(), null, 2); this.tab.set('json'); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }

  protected showBuilder() {
    if (this.tab() === 'builder') return;
    try { this.fromContent(JSON.parse(this.jsonText)); this.tab.set('builder'); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }

  async submit() {
    let content: Record<string, unknown>;
    try { content = this.tab() === 'json' ? JSON.parse(this.jsonText) : this.toContent(); }
    catch (e) { this.error.set((e as Error).message); return; }
    const key = String(content['page'] ?? '');
    this.busy.set(true);
    try {
      const set = await firstValueFrom(this.api.submitChangeSet(this.projectId(), {
        title: this.changeTitle.trim(), source: 'central',
        items: [{ assetType: 'page', key, baseVersion: this.isNew() ? null : this.version(), content }],
      }));
      await this.router.navigate(['/change-sets', set.id]);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
