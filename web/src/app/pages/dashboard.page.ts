import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Dashboard } from '../core/models';
import { StatusBadge } from './status-badge';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

/** The organisation at a glance: what is failing now, pass rates, flaky tests, agents (backlog §11). */
@Component({
  selector: 'at-dashboard',
  standalone: true,
  imports: [RouterLink, TranslatePipe, StatusBadge, ErrorState, LoadingState, EmptyState],
  template: `
    <h1>{{ 'Dashboard' | t }}</h1>
    <at-error [message]="error()" />
    @if (data(); as d) {
      <div class="grid">
        <div class="at-card"><div class="at-muted">{{ 'Projects' | t }}</div><div class="big">{{ i18n.number(d.projects) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Runs, last 7 days' | t }}</div><div class="big">{{ i18n.number(d.runs7d) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Pass rate, last 30 days' | t }}</div><div class="big">{{ d.passRate30d === null ? '—' : i18n.number(d.passRate30d) + '%' }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Healed, last 30 days' | t }}</div><div class="big">{{ i18n.number(d.healed30d) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Running now' | t }}</div><div class="big">{{ i18n.number(d.active) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Agents online' | t }}</div><div class="big" [class.bad]="d.agentsOnline === 0">{{ i18n.number(d.agentsOnline) }}</div></div>
      </div>

      <h2>{{ 'Project health' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Last run' | t }}</th><th>{{ 'Failing now' | t }}</th><th>{{ 'Pass rate, last 30 days' | t }}</th><th>{{ 'Runs, last 7 days' | t }}</th></tr></thead>
        <tbody>
          @for (p of d.projectHealth; track p.id) {
            <tr>
              <td><a [routerLink]="['/projects', p.id]">{{ p.name }}</a> <span class="at-muted mono">{{ p.key }}</span></td>
              <td>@if (p.lastExecutionId) { <a [routerLink]="['/runs', p.lastExecutionId]"><at-status [status]="p.lastStatus ?? ''" /></a> {{ i18n.date(p.lastRunAt) }} } @else { — }</td>
              <td [class.bad]="p.failingNow > 0">{{ i18n.number(p.failingNow) }}</td>
              <td>
                @if (p.passRate30d !== null) {
                  <div class="bar" [attr.aria-label]="i18n.number(p.passRate30d) + '%'"><span [style.inline-size.%]="p.passRate30d"></span></div>
                  {{ i18n.number(p.passRate30d) }}%
                } @else { — }
              </td>
              <td>{{ i18n.number(p.runs7d) }}</td>
            </tr>
          } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
        </tbody>
      </table>

      <h2>{{ 'Flaky tests, last 30 days' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Project' | t }}</th><th>{{ 'Flaky' | t }}</th><th>{{ 'Runs' | t }}</th></tr></thead>
        <tbody>
          @for (f of d.flaky; track $index) {
            <tr>
              <td>{{ f.title }}<div class="at-muted">{{ f.module }}</div></td>
              <td><a [routerLink]="['/projects', f.projectId]" class="mono">{{ f.projectKey }}</a></td>
              <td>{{ i18n.number(f.flaky) }}</td>
              <td>{{ i18n.number(f.runs) }}</td>
            </tr>
          } @empty { <tr><td colspan="4"><at-empty text="No flaky tests." /></td></tr> }
        </tbody>
      </table>
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--at-space-4); margin-block-end: var(--at-space-6); }
    .big { font-size: 26px; font-weight: 700; } .bad { color: var(--at-color-bad); font-weight: 600; }
    .bar { display: inline-block; inline-size: 120px; block-size: 8px; border-radius: 999px; background: var(--at-color-border); overflow: hidden; vertical-align: middle; margin-inline-end: var(--at-space-2); }
    .bar span { display: block; block-size: 100%; background: var(--at-color-ok); }
  `],
})
export class DashboardPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly data = signal<Dashboard | null>(null);
  protected readonly error = signal<string | null>(null);

  async ngOnInit() {
    try { this.data.set(await firstValueFrom(this.api.dashboard())); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
