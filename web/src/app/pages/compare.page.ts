import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Comparison } from '../core/models';
import { StatusBadge } from './status-badge';
import { ErrorState, LoadingState } from '../core/states';

/** Two runs side by side: what broke, what was fixed, what is new (backlog §11). */
@Component({
  selector: 'at-compare',
  standalone: true,
  imports: [RouterLink, TranslatePipe, StatusBadge, ErrorState, LoadingState],
  template: `
    <at-error [message]="error()" />
    @if (data(); as d) {
      <div class="at-row">
        <h1 class="at-grow">{{ 'Compare runs' | t }}</h1>
        <a class="at-btn" [routerLink]="['/projects', d.after.projectId]">{{ 'Back' | t }}</a>
      </div>
      <p class="at-muted">
        <a [routerLink]="['/runs', d.before.id]">{{ i18n.date(d.before.finishedAt ?? d.before.queuedAt) }}</a> ({{ d.before.environment }})
        → <a [routerLink]="['/runs', d.after.id]">{{ i18n.date(d.after.finishedAt ?? d.after.queuedAt) }}</a> ({{ d.after.environment }})
      </p>
      <div class="grid">
        @for (k of kinds; track k) {
          <div class="at-card"><div class="at-muted">{{ k | t }}</div><div class="big" [class.bad]="k === 'broke'" [class.ok]="k === 'fixed'">{{ i18n.number(d.summary[k] || 0) }}</div></div>
        }
      </div>
      <table class="at-table">
        <thead><tr><th>{{ 'Change' | t }}</th><th>{{ 'Name' | t }}</th><th>{{ 'Before' | t }}</th><th>{{ 'After' | t }}</th></tr></thead>
        <tbody>
          @for (r of d.tests; track $index) {
            <tr>
              <td>{{ r.change | t }}</td>
              <td>{{ r.title }}<div class="at-muted">{{ r.module }}</div></td>
              <td>@if (r.before) { <at-status [status]="r.before" /> } @else { — }</td>
              <td>@if (r.after) { <at-status [status]="r.after" /> } @else { — }</td>
            </tr>
          }
        </tbody>
      </table>
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--at-space-4); margin-block: var(--at-space-4); }
    .big { font-size: 24px; font-weight: 700; } .bad { color: var(--at-color-bad); } .ok { color: var(--at-color-ok); }
  `],
})
export class ComparePage {
  /** query parameters ?before=&after= */
  readonly before = input.required<string>();
  readonly after = input.required<string>();
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly data = signal<Comparison | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly kinds = ['broke', 'fixed', 'still_failing', 'added', 'removed', 'unchanged'];

  constructor() {
    effect(() => { void this.load(this.before(), this.after()); });
  }

  private async load(before: string, after: string) {
    try { this.data.set(await firstValueFrom(this.api.compare(before, after))); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
