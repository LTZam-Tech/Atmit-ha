import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { CiToken, Project, Workspace } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

/** Tokens that let a CI pipeline start runs and read their results (scripts/ci-run.ts). */
@Component({
  selector: 'at-ci-tokens',
  standalone: true,
  imports: [FormsModule, TranslatePipe, EmptyState, ErrorState],
  template: `
    <h1>{{ 'CI tokens' | t }}</h1>
    <at-error [message]="error()" />
    @if (secret()) {
      <div class="at-card at-stack secret" role="status">
        <b>{{ 'Copy this token now: it is shown only once.' | t }}</b>
        <code dir="ltr">{{ secret() }}</code>
        <div class="at-muted">{{ 'In the pipeline:' | t }}</div>
        <pre class="at-pre" dir="ltr">ATIMTHA_PLATFORM_URL={{ origin }} ATIMTHA_CI_TOKEN=&lt;token&gt; npx tsx scripts/ci-run.ts &lt;project&gt; --suite smoke --junit results/atimtha.xml</pre>
        <div><button type="button" class="at-btn" (click)="secret.set(null)">{{ 'Done' | t }}</button></div>
      </div>
    }
    <form class="at-card at-row wrap" (ngSubmit)="create()">
      <div class="at-field"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="n" [(ngModel)]="name" placeholder="GitHub Actions"></div>
      <div class="at-field"><label for="p">{{ 'Project' | t }}</label>
        <select id="p" class="at-select" name="p" [(ngModel)]="projectId">
          <option value="">{{ 'All projects' | t }}</option>
          @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
        </select></div>
      <label class="at-row"><input type="checkbox" name="s" [(ngModel)]="canStart"> {{ 'Start runs' | t }}</label>
      <label class="at-row"><input type="checkbox" name="r" [(ngModel)]="canRead"> {{ 'Read results' | t }}</label>
      <div class="at-field"><label for="d">{{ 'Expires after (days)' | t }}</label><input id="d" class="at-input" type="number" min="1" max="730" name="d" [(ngModel)]="days"></div>
      <button type="submit" class="at-btn primary" [disabled]="!name.trim() || !(canStart || canRead)">{{ 'Create token' | t }}</button>
    </form>
    <table class="at-table">
      <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Token' | t }}</th><th>{{ 'Project' | t }}</th><th>{{ 'Allowed' | t }}</th><th>{{ 'Last used' | t }}</th><th>{{ 'Expires' | t }}</th><th></th></tr></thead>
      <tbody>
        @for (t of tokens(); track t.id) {
          <tr [class.revoked]="t.revokedAt">
            <td>{{ t.name }}</td>
            <td class="mono" dir="ltr">{{ t.hint }}</td>
            <td>{{ projectName(t.projectId) }}</td>
            <td class="mono" dir="ltr">{{ t.scopes.join(', ') }}</td>
            <td>{{ t.lastUsedAt ? i18n.date(t.lastUsedAt) : '—' }}</td>
            <td>{{ t.expiresAt ? i18n.date(t.expiresAt) : ('Never' | t) }}</td>
            <td>@if (t.revokedAt) { {{ 'Revoked' | t }} } @else { <button type="button" class="at-btn danger" (click)="revoke(t)">{{ 'Revoke' | t }}</button> }</td>
          </tr>
        } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
      </tbody>
    </table>
  `,
  styles: [`
    form.at-card { margin-block-end: var(--at-space-4); } .wrap { flex-wrap: wrap; align-items: end; }
    .secret { margin-block-end: var(--at-space-4); border-color: var(--at-color-primary); } .secret code { font-size: 14px; word-break: break-all; }
    tr.revoked td { opacity: 0.55; }
  `],
})
export class CiTokensPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly tokens = signal<CiToken[]>([]);
  protected readonly projects = signal<Project[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly secret = signal<string | null>(null);
  protected readonly origin = location.origin;
  protected name = '';
  protected projectId = '';
  protected canStart = true;
  protected canRead = true;
  protected days: number | null = 365;

  async ngOnInit() {
    try {
      const workspaces: Workspace[] = await firstValueFrom(this.api.workspaces());
      this.projects.set((await Promise.all(workspaces.map((w) => firstValueFrom(this.api.projects(w.key))))).flat());
    } catch { /* "all projects" still works */ }
    await this.load();
  }

  private async load() {
    try { this.tokens.set(await firstValueFrom(this.api.ciTokens())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected projectName(id: string | null) {
    return id ? (this.projects().find((p) => p.id === id)?.name ?? id) : this.i18n.t('All projects');
  }

  async create() {
    const scopes = [...(this.canStart ? ['runs.start'] : []), ...(this.canRead ? ['runs.read'] : [])];
    try {
      const created = await firstValueFrom(this.api.createCiToken({ name: this.name.trim(), projectId: this.projectId || null, scopes, expiresInDays: this.days || null }));
      this.secret.set(created.secret);
      this.name = '';
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async revoke(t: CiToken) {
    if (!confirm(this.i18n.t('Revoke {name}? Pipelines using it stop working.', { name: t.name }))) return;
    try { await firstValueFrom(this.api.revokeCiToken(t.id)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
