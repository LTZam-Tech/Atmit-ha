import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { Session } from '../core/session';
import { I18n, TranslatePipe } from '../core/i18n';
import type { ChangeSetDetail } from '../core/models';
import { StatusBadge } from './status-badge';
import { ErrorState, LoadingState } from '../core/states';

/** Review a change set: current version beside the proposed one, conflicts flagged; approve or reject (ADR-0007). */
@Component({
  selector: 'at-change-set',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, StatusBadge, LoadingState, ErrorState],
  template: `
    <at-error [message]="error()" />
    @if (detail(); as d) {
      <div class="at-row">
        <h1 class="at-grow">{{ d.changeSet.title }} <at-status [status]="d.changeSet.status" /></h1>
        <a class="at-btn" [routerLink]="['/projects', d.changeSet.projectId]">{{ 'Back' | t }}</a>
      </div>
      <p class="at-muted">
        {{ 'Author' | t }}: <span dir="ltr">{{ d.changeSet.createdBy }}</span> · {{ (d.changeSet.source === 'local' ? 'Offline draft' : 'Edited in the platform') | t }} ·
        {{ i18n.date(d.changeSet.createdAt) }}
        @if (d.changeSet.reviewedBy) { · {{ 'Reviewer' | t }}: <span dir="ltr">{{ d.changeSet.reviewedBy }}</span> }
      </p>
      @if (d.changeSet.decisionNote) { <p class="at-card">{{ d.changeSet.decisionNote }}</p> }
      @if (d.changeSet.hasConflicts) { <p class="at-alert">{{ 'Some items changed since this edit started. Reject it and submit the edit again on top of the current version.' | t }}</p> }

      @for (item of d.items; track item.id) {
        <section class="at-card at-stack item">
          <h2>
            <span class="at-badge">{{ (item.assetType === 'page' ? 'Page' : item.assetType === 'workflow' ? 'Workflow' : 'Test case') | t }}</span>
            <span class="mono">{{ item.key }}</span>
            @if (item.isNew) { <span class="at-badge ok">{{ 'new' | t }}</span> }
            @else { <span class="at-muted">v{{ item.baseVersion }} → {{ 'proposed' | t }}</span> }
            @if (item.conflict) { <span class="at-badge bad">{{ 'conflict' | t }} (v{{ item.currentVersion }})</span> }
          </h2>
          <div class="sides">
            <div><div class="at-muted">{{ 'Current' | t }}</div><pre class="at-pre" dir="ltr">{{ item.current ? pretty(item.current) : '—' }}</pre></div>
            <div><div class="at-muted">{{ 'Proposed' | t }}</div><pre class="at-pre" dir="ltr">{{ pretty(item.content) }}</pre></div>
          </div>
        </section>
      }

      @if (d.changeSet.status === 'submitted' && session.can('project.edit')) {
        <form class="at-card at-row" (ngSubmit)="approve()">
          <input class="at-input at-grow" name="note" [(ngModel)]="note" [placeholder]="'Note for the author (optional)' | t">
          <button type="button" class="at-btn danger" (click)="reject()" [disabled]="busy()">{{ 'Reject' | t }}</button>
          <button type="submit" class="at-btn primary" [disabled]="busy() || d.changeSet.hasConflicts">{{ 'Approve and apply' | t }}</button>
        </form>
      }
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .item { margin-block: var(--at-space-4); }
    .sides { display: grid; grid-template-columns: 1fr 1fr; gap: var(--at-space-4); }
    @media (max-width: 900px) { .sides { grid-template-columns: 1fr; } }
  `],
})
export class ChangeSetPage {
  readonly changeSetId = input.required<string>();
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  protected readonly i18n = inject(I18n);
  protected readonly detail = signal<ChangeSetDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected note = '';

  constructor() {
    effect(() => { void this.load(this.changeSetId()); });
  }

  protected pretty(v: unknown) { return JSON.stringify(v, null, 2); }

  private async load(id: string) {
    try { this.detail.set(await firstValueFrom(this.api.changeSet(id))); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async approve() { await this.decide(() => firstValueFrom(this.api.approveChangeSet(this.changeSetId(), this.note || undefined))); }
  async reject() { await this.decide(() => firstValueFrom(this.api.rejectChangeSet(this.changeSetId(), this.note || undefined))); }

  private async decide(call: () => Promise<unknown>) {
    this.busy.set(true);
    try { await call(); await this.load(this.changeSetId()); }
    catch (e) { this.error.set(problemText(e)); }
    finally { this.busy.set(false); }
  }
}
