import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { PageDetail } from '../core/models';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

/** One page of the object repository: elements, locators, fallbacks, navigation, and which locators keep healing. */
@Component({
  selector: 'at-page-detail',
  standalone: true,
  imports: [RouterLink, TranslatePipe, ErrorState, LoadingState, EmptyState],
  template: `
    <at-error [message]="error()" />
    @if (page(); as p) {
      <div class="at-row">
        <h1 class="at-grow">{{ 'Page' | t }} <span class="mono">{{ p.key }}</span> <span class="at-badge">v{{ p.version }}</span></h1>
        <a class="at-btn primary" [routerLink]="['/projects', projectId(), 'pages', p.key, 'edit']">{{ 'Edit' | t }}</a>
        <a class="at-btn" [routerLink]="['/projects', projectId()]">{{ 'Back' | t }}</a>
      </div>
      @if (p.description) { <p>{{ p.description }}</p> }
      <div class="grid">
        <div class="at-card"><div class="at-muted">{{ 'Opens by' | t }}</div><div>{{ (p.openMode === 'url' ? 'address' : 'navigation') | t }}</div>
          @if (p.url) { <div class="mono" dir="ltr">{{ p.url }}</div> }</div>
        <div class="at-card"><div class="at-muted">{{ 'Ready when' | t }}</div><div class="mono">{{ p.readyWhen ?? '—' }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Signed in as' | t }}</div><div class="mono">{{ p.loggedOut ? ('Signed out' | t) : (p.signedInAs ?? '—') }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Needed healing, last 30 days' | t }}</div><div class="big" [class.bad]="healed() > 0">{{ i18n.number(healed()) }}</div></div>
      </div>

      <h2>{{ 'Elements' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Key' | t }}</th><th>{{ 'Locator' | t }}</th><th>{{ 'Fallbacks' | t }}</th><th>{{ 'Control' | t }}</th><th>{{ 'Healed' | t }}</th></tr></thead>
        <tbody>
          @for (e of p.elements; track e.key) {
            <tr [class.warn]="e.healed30d > 0">
              <td class="mono">{{ e.key }}
                @if (e.within) { <div class="at-muted">{{ 'inside' | t }} {{ e.within }}</div> }
                @if (e.description) { <div class="at-muted">{{ e.description }}</div> }</td>
              <td><code dir="ltr">{{ show(e.locator) }}</code>
                @if (e.frame) { <div class="at-muted mono" dir="ltr">frame: {{ e.frame }}</div> }
                @if (e.nth !== null) { <div class="at-muted mono" dir="ltr">nth: {{ e.nth }}</div> }
                @if (e.hasText) { <div class="at-muted mono" dir="ltr">hasText: {{ e.hasText }}</div> }</td>
              <td>@for (f of e.fallbacks; track $index) { <div><code dir="ltr">{{ $index + 1 }}. {{ show(f) }}</code></div> } @empty { — }</td>
              <td>{{ e.control ?? '—' }}</td>
              <td>@if (e.healed30d > 0) { <b class="bad">{{ i18n.number(e.healed30d) }}</b><div class="at-muted">{{ e.lastHealedBy }}</div> } @else { — }</td>
            </tr>
          } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
        </tbody>
      </table>

      <div class="links">
        <section class="at-card"><h2>{{ 'Leads to' | t }}</h2>
          @for (l of p.leadsTo; track l.page) { <div><a [routerLink]="['/projects', projectId(), 'pages', l.page]" class="mono">{{ l.page }}</a> <span class="at-muted">({{ i18n.number(l.steps) }} {{ 'steps' | t }})</span></div> }
          @empty { <p class="at-muted">—</p> }</section>
        <section class="at-card"><h2>{{ 'Reached from' | t }}</h2>
          @for (l of p.reachedFrom; track l.page) { <div><a [routerLink]="['/projects', projectId(), 'pages', l.page]" class="mono">{{ l.page }}</a> <span class="at-muted">({{ i18n.number(l.steps) }} {{ 'steps' | t }})</span></div> }
          @empty { <p class="at-muted">—</p> }</section>
      </div>
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--at-space-4); margin-block: var(--at-space-4); }
    .big { font-size: 24px; font-weight: 700; } .bad { color: var(--at-color-bad); }
    tr.warn td:first-child { border-inline-start: 3px solid var(--at-color-bad); }
    code { white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    .links { display: grid; grid-template-columns: 1fr 1fr; gap: var(--at-space-4); margin-block-start: var(--at-space-4); }
    @media (max-width: 800px) { .links { grid-template-columns: 1fr; } }
  `],
})
export class PageDetailPage {
  readonly projectId = input.required<string>();
  readonly pageKey = input.required<string>();
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly page = signal<PageDetail | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => { void this.load(this.projectId(), this.pageKey()); });
  }

  protected healed() { return this.page()?.elements.reduce((n, e) => n + e.healed30d, 0) ?? 0; }

  /** {"testid":"login"} → testid=login · {"role":"button","name":"Save"} → role=button name=Save */
  protected show(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v !== 'object') return String(v);
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' ');
  }

  private async load(projectId: string, key: string) {
    this.page.set(null);
    try { this.page.set(await firstValueFrom(this.api.pageDetail(projectId, key))); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
