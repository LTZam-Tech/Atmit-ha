import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Agent } from '../core/models';
import { StatusBadge } from './status-badge';
import { EmptyState, ErrorState } from '../core/states';

/** Execution agents of the organisation (org admins): create (token shown once), see heartbeats, revoke. */
@Component({
  selector: 'at-agents',
  standalone: true,
  imports: [FormsModule, TranslatePipe, StatusBadge, ErrorState, EmptyState],
  template: `
    <h1>{{ 'Agents' | t }}</h1>
    <at-error [message]="error()" />
    @if (token(); as tk) {
      <div class="at-card at-stack token" role="status">
        <b>{{ 'Copy this token now: it is shown only once.' | t }}</b>
        <code dir="ltr">{{ tk }}</code>
      </div>
    }
    <form class="at-card at-row" (ngSubmit)="create()">
      <div class="at-field"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="name" [(ngModel)]="name" dir="ltr"></div>
      <div class="at-field"><label for="k">{{ 'Kind' | t }}</label>
        <select id="k" class="at-select" name="kind" [(ngModel)]="kind">
          <option value="central">{{ 'central' | t }}</option><option value="local">{{ 'local' | t }}</option><option value="private">{{ 'private' | t }}</option>
        </select></div>
      <label><input type="checkbox" name="web" [(ngModel)]="web"> {{ 'web' | t }}</label>
      <label><input type="checkbox" name="api" [(ngModel)]="apiEngine"> {{ 'api' | t }}</label>
      <label><input type="checkbox" name="mobile" [(ngModel)]="mobileEngine"> {{ 'mobile' | t }}</label>
      <label><input type="checkbox" name="perf" [(ngModel)]="perfEngine"> {{ 'performance' | t }}</label>
      <button type="submit" class="at-btn primary" [disabled]="!name || (!web && !apiEngine && !mobileEngine && !perfEngine)">{{ 'New agent' | t }}</button>
    </form>
    <table class="at-table">
      <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Kind' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Engines' | t }}</th><th>{{ 'Version' | t }}</th><th>{{ 'Last heartbeat' | t }}</th><th></th></tr></thead>
      <tbody>
        @for (a of agents(); track a.id) {
          <tr>
            <td>{{ a.name }}</td><td>{{ a.kind | t }}</td><td><at-status [status]="a.status" /></td>
            <td>{{ (a.capabilities?.engines ?? []).join(', ') }}@if ((a.capabilities?.slots ?? 1) > 1) { <span class="at-muted"> · {{ 'parallel jobs: {n}' | t: { n: a.capabilities?.slots ?? 1 } }}</span> }</td><td class="mono">{{ a.version ?? '—' }}</td>
            <td>{{ i18n.date(a.lastHeartbeatAt) }}</td>
            <td>@if (a.status !== 'revoked') {
              <button type="button" class="at-btn" (click)="rotate(a)">{{ 'New token' | t }}</button>
              <button type="button" class="at-btn danger" (click)="revoke(a)">{{ 'Revoke' | t }}</button> }</td>
          </tr>
        } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
      </tbody>
    </table>
  `,
  styles: [`
    form.at-card, .token { margin-block-end: var(--at-space-4); }
    form.at-card { align-items: end; }
    .token code { padding: var(--at-space-2); background: var(--at-color-bg); border-radius: var(--at-radius-sm); word-break: break-all; user-select: all; }
  `],
})
export class AgentsPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly agents = signal<Agent[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly token = signal<string | null>(null);
  protected name = '';
  protected kind: 'central' | 'local' | 'private' = 'private';
  protected web = true;
  protected apiEngine = true;
  protected mobileEngine = false;
  protected perfEngine = false;

  async ngOnInit() { await this.load(); }

  private async load() {
    try { this.agents.set(await firstValueFrom(this.api.agents())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async create() {
    try {
      const engines = [...(this.web ? ['web'] : []), ...(this.apiEngine ? ['api'] : []), ...(this.mobileEngine ? ['mobile'] : []), ...(this.perfEngine ? ['performance'] : [])];
      const created = await firstValueFrom(this.api.createAgent({ name: this.name.trim(), kind: this.kind, engines }));
      this.token.set(created.token);
      this.name = '';
      await this.load();
    } catch (e) {
      this.error.set(problemText(e));
    }
  }

  /** the old token stops working at once; the new one is shown once, like at registration */
  async rotate(a: Agent) {
    if (!confirm(this.i18n.t('Give {name} a new token? The current token stops working at once.', { name: a.name }))) return;
    try { this.token.set((await firstValueFrom(this.api.rotateAgentToken(a.id))).token); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async revoke(a: Agent) {
    if (!confirm(this.i18n.t('Revoke this agent? Its unfinished jobs go back to the queue.'))) return;
    try { await firstValueFrom(this.api.revokeAgent(a.id)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
