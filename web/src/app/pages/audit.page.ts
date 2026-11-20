import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { AuditEntry } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

/** Who changed what (append-only audit log), newest first, with filters and "load more". */
@Component({
  selector: 'at-audit',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorState, EmptyState],
  template: `
    <h1>{{ 'Audit log' | t }}</h1>
    <at-error [message]="error()" />
    <form class="at-card at-row" (ngSubmit)="reload()">
      <div class="at-field"><label for="a">{{ 'Action' | t }}</label><input id="a" class="at-input" name="action" [(ngModel)]="action" dir="ltr" placeholder="project."></div>
      <div class="at-field"><label for="t">{{ 'Resource' | t }}</label><input id="t" class="at-input" name="type" [(ngModel)]="resourceType" dir="ltr" placeholder="execution"></div>
      <button type="submit" class="at-btn primary">{{ 'Filter' | t }}</button>
    </form>
    <table class="at-table">
      <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'Who' | t }}</th><th>{{ 'Action' | t }}</th><th>{{ 'Resource' | t }}</th><th>{{ 'Details' | t }}</th></tr></thead>
      <tbody>
        @for (e of entries(); track e.id) {
          <tr>
            <td>{{ i18n.date(e.at) }}</td>
            <td class="mono" dir="ltr">{{ e.actor ?? '—' }}</td>
            <td class="mono" dir="ltr">{{ e.action }}</td>
            <td class="mono" dir="ltr">{{ e.resourceType }} {{ e.resourceId }}</td>
            <td><code dir="ltr" class="details">{{ e.details }}</code></td>
          </tr>
        } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
      </tbody>
    </table>
    @if (more()) { <p><button type="button" class="at-btn" (click)="loadMore()">{{ 'Load more' | t }}</button></p> }
  `,
  styles: [`
    form.at-card { margin-block-end: var(--at-space-4); align-items: end; }
    .details { display: block; max-inline-size: 420px; white-space: pre-wrap; word-break: break-word; }
  `],
})
export class AuditPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly entries = signal<AuditEntry[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly more = signal(false);
  protected action = '';
  protected resourceType = '';

  async ngOnInit() { await this.reload(); }

  async reload() {
    this.entries.set([]);
    await this.loadMore();
  }

  async loadMore() {
    try {
      const before = this.entries().at(-1)?.id;
      const page = await firstValueFrom(this.api.audit({ action: this.action.trim() || undefined, resourceType: this.resourceType.trim() || undefined, before }));
      this.entries.set([...this.entries(), ...page]);
      this.more.set(page.length === 100);
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }
}
