import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Coverage, HealingReport } from '../core/models';
import { StatusBadge } from './status-badge';
import { EmptyState, ErrorState } from '../core/states';

/** Project analytics (backlog §11): coverage per module, suite and case; locators that keep needing self-healing. */
@Component({
  selector: 'at-project-analytics',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, StatusBadge, ErrorState, EmptyState],
  template: `
    <at-error [message]="error()" />
    <div class="at-row filters">
      <label for="ad">{{ 'Period' | t }}</label>
      <select id="ad" class="at-select" [(ngModel)]="days" (ngModelChange)="load()">
        <option [ngValue]="7">{{ 'Last 7 days' | t }}</option><option [ngValue]="30">{{ 'Last 30 days' | t }}</option>
        <option [ngValue]="90">{{ 'Last 90 days' | t }}</option><option [ngValue]="365">{{ 'Last year' | t }}</option>
      </select>
    </div>

    @if (coverage(); as c) {
      <div class="grid">
        <div class="at-card"><div class="at-muted">{{ 'Test cases' | t }}</div><div class="big">{{ i18n.number(c.cases) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Never run in this period' | t }}</div><div class="big" [class.bad]="c.neverRun > 0">{{ i18n.number(c.neverRun) }}</div></div>
        @if (healing(); as h) {
          <div class="at-card"><div class="at-muted">{{ 'Self-healing events' | t }}</div><div class="big">{{ i18n.number(h.heals) }}</div></div>
          <div class="at-card"><div class="at-muted">{{ 'Locators to fix' | t }}</div><div class="big" [class.bad]="h.locators.length > 0">{{ i18n.number(h.locators.length) }}</div></div>
        }
      </div>

      <h2>{{ 'Coverage by module' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Module' | t }}</th><th>{{ 'Test cases' | t }}</th><th>{{ 'Rows' | t }}</th><th>{{ 'Passing' | t }}</th><th>{{ 'Failing' | t }}</th><th>{{ 'Never run' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (m of c.modules; track m.module) {
            <tr><td>{{ m.module }}</td><td>{{ i18n.number(m.cases) }}</td><td>{{ i18n.number(m.rows) }}</td>
              <td class="ok">{{ i18n.number(m.passing) }}</td><td [class.bad]="m.failing > 0">{{ i18n.number(m.failing) }}</td><td>{{ i18n.number(m.neverRun) }}</td>
              <td><div class="bar" [attr.aria-label]="pct(m.passing, m.cases) + '%'"><span [style.inline-size.%]="pct(m.passing, m.cases)"></span></div></td></tr>
          }
        </tbody>
      </table>

      @if (c.suites.length) {
        <h2>{{ 'Suites' | t }}</h2>
        <p>@for (s of c.suites; track s.key) { <span class="at-badge mono">{{ s.key }}: {{ i18n.number(s.cases) }}</span> }</p>
      }

      <h2>{{ 'Test cases' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Last result' | t }}</th><th>{{ 'Runs' | t }}</th><th>{{ 'Failures' | t }}</th><th>{{ 'Suites' | t }}</th></tr></thead>
        <tbody>
          @for (k of c.caseList; track k.key) {
            <tr>
              <td><a [routerLink]="['/projects', projectId(), 'cases', k.key]">{{ k.title }}</a><div class="at-muted">{{ k.module }} · {{ k.engine | t }}</div></td>
              <td>@if (k.lastExecutionId) { <a [routerLink]="['/runs', k.lastExecutionId]"><at-status [status]="k.lastStatus ?? ''" /></a> <span class="at-muted">{{ i18n.date(k.lastRunAt) }}</span> }
                @else { <span class="at-muted">{{ 'Never run' | t }}</span> }</td>
              <td>{{ i18n.number(k.runs) }}</td>
              <td [class.bad]="k.failures > 0">{{ i18n.number(k.failures) }}</td>
              <td class="mono">{{ k.suites.join(', ') || '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }

    @if (healing(); as h) {
      <h2>{{ 'Locators that needed self-healing' | t }}</h2>
      <p class="at-muted">{{ 'A healed test passed only because a fallback found the element: update these locators in the object repository.' | t }}</p>
      <table class="at-table">
        <thead><tr><th>{{ 'Element' | t }}</th><th>{{ 'Kind' | t }}</th><th>{{ 'Times' | t }}</th><th>{{ 'Tests' | t }}</th><th>{{ 'Healed by' | t }}</th><th>{{ 'Last' | t }}</th></tr></thead>
        <tbody>
          @for (l of h.locators; track $index) {
            <tr>
              <td class="mono">@if (pageOf(l.target); as pg) { <a [routerLink]="['/projects', projectId(), 'pages', pg]">{{ l.target }}</a> } @else { {{ l.target }} }
                @if (l.duringChecks) { <div class="at-badge bad">{{ 'during a check' | t }}</div> }</td>
              <td>{{ l.kind }}</td>
              <td class="bad">{{ i18n.number(l.count) }}</td>
              <td>{{ i18n.number(l.tests) }}</td>
              <td>{{ l.lastHealedBy }}@if (l.fix) { <div class="at-muted">{{ l.fix }}</div> }</td>
              <td>{{ i18n.date(l.lastAt) }}</td>
            </tr>
          } @empty { <tr><td colspan="6"><at-empty text="No self-healing in this period." /></td></tr> }
        </tbody>
      </table>
    }
  `,
  styles: [`
    .filters { margin-block-end: var(--at-space-4); gap: var(--at-space-2); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--at-space-4); margin-block-end: var(--at-space-4); }
    .big { font-size: 26px; font-weight: 700; } .bad { color: var(--at-color-bad); } .ok { color: var(--at-color-ok); }
    .bar { inline-size: 120px; block-size: 8px; border-radius: 999px; background: var(--at-color-border); overflow: hidden; }
    .bar span { display: block; block-size: 100%; background: var(--at-color-ok); }
  `],
})
export class ProjectAnalyticsComponent implements OnInit {
  readonly projectId = input.required<string>();
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly coverage = signal<Coverage | null>(null);
  protected readonly healing = signal<HealingReport | null>(null);
  protected readonly error = signal<string | null>(null);
  protected days = 30;

  async ngOnInit() { await this.load(); }

  async load() {
    try {
      const [c, h] = await Promise.all([firstValueFrom(this.api.coverage(this.projectId(), this.days)), firstValueFrom(this.api.healing(this.projectId(), this.days))]);
      this.coverage.set(c);
      this.healing.set(h);
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected pct(part: number, whole: number) { return whole ? Math.round((100 * part) / whole) : 0; }
  protected pageOf(target: string) { const i = target.indexOf('.'); return i > 0 ? target.slice(0, i) : null; }
}
