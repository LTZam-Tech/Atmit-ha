import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Integration } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

type Kind = 'jira' | 'azure_devops' | 'testrail';

interface TrackerForm {
  id: string | null; kind: Kind; name: string; baseUrl: string; credentialSecretRef: string; enabled: boolean;
  // Jira
  projectKey: string; issueType: string; auth: 'basic' | 'bearer'; email: string; labels: string;
  // Azure DevOps
  project: string; workItemType: string; areaPath: string; tags: string;
  // TestRail
  projectId: string; suiteId: string; closeRun: boolean;
}

/** Defect trackers (ADR-0010): Jira and Azure DevOps. The token is a secrets-store reference, never the token. */
@Component({
  selector: 'at-integrations',
  standalone: true,
  imports: [FormsModule, TranslatePipe, EmptyState, ErrorState],
  template: `
    <h1>{{ 'Integrations' | t }}</h1>
    <at-error [message]="error()" />
    @if (note()) { <p class="at-card" role="status">{{ note() }}</p> }

    <form class="at-card at-stack" (ngSubmit)="save()">
      <h2>{{ (form.id ? 'Edit connection' : 'New connection') | t }}</h2>
      <div class="at-row wrap">
        <div class="at-field"><label for="kind">{{ 'Tracker' | t }}</label>
          <select id="kind" class="at-select" name="kind" [(ngModel)]="form.kind" (ngModelChange)="kindChanged()" [disabled]="!!form.id">
            <option value="jira">Jira</option><option value="azure_devops">Azure DevOps</option><option value="testrail">TestRail</option>
          </select></div>
        <div class="at-field"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="n" [(ngModel)]="form.name"></div>
        <div class="at-field at-grow"><label for="u">{{ (form.kind === 'jira' ? 'Jira address' : form.kind === 'testrail' ? 'TestRail address' : 'Organisation address') | t }}</label>
          <input id="u" class="at-input" name="u" [(ngModel)]="form.baseUrl" dir="ltr"
            [placeholder]="form.kind === 'jira' ? 'https://your-team.atlassian.net' : form.kind === 'testrail' ? 'https://your-team.testrail.io' : 'https://dev.azure.com/your-organisation'"></div>
      </div>

      @if (form.kind === 'jira') {
        <div class="at-row wrap">
          <div class="at-field"><label for="k">{{ 'Project key' | t }}</label><input id="k" class="at-input" name="k" [(ngModel)]="form.projectKey" dir="ltr" placeholder="QA"></div>
          <div class="at-field"><label for="t">{{ 'Issue type' | t }}</label><input id="t" class="at-input" name="t" [(ngModel)]="form.issueType" dir="ltr"></div>
          <div class="at-field"><label for="a">{{ 'Sign-in' | t }}</label>
            <select id="a" class="at-select" name="a" [(ngModel)]="form.auth">
              <option value="basic">{{ 'Jira Cloud: email and API token' | t }}</option>
              <option value="bearer">{{ 'Data Center: personal access token' | t }}</option>
            </select></div>
          @if (form.auth === 'basic') {
            <div class="at-field"><label for="e">{{ 'Email' | t }}</label><input id="e" class="at-input" type="email" name="e" [(ngModel)]="form.email" dir="ltr"></div>
          }
          <div class="at-field"><label for="l">{{ 'Labels (comma separated)' | t }}</label><input id="l" class="at-input" name="l" [(ngModel)]="form.labels" dir="ltr" placeholder="atimtha"></div>
        </div>
      } @else if (form.kind === 'testrail') {
        <div class="at-row wrap">
          <div class="at-field"><label for="te">{{ 'Email' | t }}</label><input id="te" class="at-input" type="email" name="te" [(ngModel)]="form.email" dir="ltr"></div>
          <div class="at-field"><label for="tp">{{ 'Project id' | t }}</label><input id="tp" class="at-input" name="tp" [(ngModel)]="form.projectId" dir="ltr" placeholder="7"></div>
          <div class="at-field"><label for="ts">{{ 'Suite id (optional)' | t }}</label><input id="ts" class="at-input" name="ts" [(ngModel)]="form.suiteId" dir="ltr"></div>
          <label class="at-row"><input type="checkbox" name="tc" [(ngModel)]="form.closeRun"> {{ 'Close the TestRail run after publishing' | t }}</label>
        </div>
        <p class="at-muted">{{ 'Link a test case (or one data row) to TestRail with a tag such as @C123.' | t }}</p>
      } @else {
        <div class="at-row wrap">
          <div class="at-field"><label for="p">{{ 'Project' | t }}</label><input id="p" class="at-input" name="p" [(ngModel)]="form.project"></div>
          <div class="at-field"><label for="w">{{ 'Work item type' | t }}</label><input id="w" class="at-input" name="w" [(ngModel)]="form.workItemType" dir="ltr"></div>
          <div class="at-field at-grow"><label for="ar">{{ 'Area path (optional)' | t }}</label><input id="ar" class="at-input" name="ar" [(ngModel)]="form.areaPath" dir="ltr"></div>
          <div class="at-field"><label for="tg">{{ 'Tags (comma separated)' | t }}</label><input id="tg" class="at-input" name="tg" [(ngModel)]="form.tags" dir="ltr" placeholder="atimtha"></div>
        </div>
      }

      <div class="at-row wrap">
        <div class="at-field at-grow"><label for="s">{{ (form.kind === 'jira' ? 'Token reference' : form.kind === 'testrail' ? 'API key reference' : 'Personal access token reference') | t }}</label>
          <input id="s" class="at-input" name="s" [(ngModel)]="form.credentialSecretRef" dir="ltr"
            [placeholder]="form.kind === 'jira' ? 'vault:env/JIRA_TOKEN' : form.kind === 'testrail' ? 'vault:env/TESTRAIL_API_KEY' : 'vault:env/AZURE_DEVOPS_PAT'"></div>
        <label class="at-row"><input type="checkbox" name="on" [(ngModel)]="form.enabled"> {{ 'Switched on' | t }}</label>
      </div>
      <div class="at-row">
        <button type="submit" class="at-btn primary" [disabled]="!valid()">{{ 'Save' | t }}</button>
        @if (form.id) { <button type="button" class="at-btn" (click)="reset()">{{ 'Cancel' | t }}</button> }
      </div>
    </form>

    <table class="at-table">
      <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Tracker' | t }}</th><th>{{ 'Address' | t }}</th><th>{{ 'Project' | t }}</th><th>{{ 'Token' | t }}</th><th>{{ 'Status' | t }}</th><th></th></tr></thead>
      <tbody>
        @for (i of items(); track i.id) {
          <tr>
            <td>{{ i.name }}</td>
            <td>{{ i.kind === 'jira' ? 'Jira' : i.kind === 'testrail' ? 'TestRail' : 'Azure DevOps' }}</td>
            <td class="mono" dir="ltr">{{ cfg(i, 'baseUrl') ?? '—' }}</td>
            <td class="mono">{{ cfg(i, 'projectKey') ?? cfg(i, 'project') ?? '—' }}</td>
            <td>{{ i.hasCredential ? '✓' : '—' }}</td>
            <td>{{ (i.enabled ? 'Switched on' : 'Switched off') | t }}</td>
            <td>
              <button type="button" class="at-btn" (click)="check(i)">{{ 'Check connection' | t }}</button>
              <button type="button" class="at-btn" (click)="edit(i)">{{ 'Edit' | t }}</button>
              <button type="button" class="at-btn danger" (click)="remove(i)">{{ 'Delete' | t }}</button>
            </td>
          </tr>
        } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
      </tbody>
    </table>
  `,
  styles: [`form.at-card { margin-block-end: var(--at-space-4); } .wrap { flex-wrap: wrap; align-items: end; }`],
})
export class IntegrationsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  protected readonly items = signal<Integration[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected form: TrackerForm = IntegrationsPage.empty('jira');

  private static empty(kind: Kind): TrackerForm {
    return {
      id: null, kind, name: kind === 'jira' ? 'Jira' : kind === 'testrail' ? 'TestRail' : 'Azure DevOps', baseUrl: '', credentialSecretRef: '', enabled: true,
      projectKey: '', issueType: 'Bug', auth: 'basic', email: '', labels: 'atimtha',
      project: '', workItemType: 'Bug', areaPath: '', tags: 'atimtha',
      projectId: '', suiteId: '', closeRun: false,
    };
  }

  async ngOnInit() { await this.load(); }

  private async load() {
    try { this.items.set(await firstValueFrom(this.api.integrations())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected cfg(i: Integration, key: string): string | null {
    const v = (i.config as Record<string, unknown>)[key];
    return typeof v === 'string' && v ? v : null;
  }

  protected valid() {
    const f = this.form;
    if (!f.name.trim() || !f.baseUrl.trim()) return false;
    if (f.kind === 'testrail') return /^\d+$/.test(f.projectId.trim()) && f.email.includes('@');
    return f.kind === 'jira' ? !!f.projectKey.trim() : !!f.project.trim();
  }

  protected kindChanged() { if (!this.form.id) this.form = { ...IntegrationsPage.empty(this.form.kind), kind: this.form.kind }; }

  protected reset() { this.form = IntegrationsPage.empty('jira'); }

  protected edit(i: Integration) {
    const c = i.config as Record<string, unknown>;
    const s = (k: string, d = '') => (typeof c[k] === 'string' ? (c[k] as string) : d);
    const list = (k: string) => (Array.isArray(c[k]) ? (c[k] as string[]).join(', ') : '');
    this.form = {
      ...IntegrationsPage.empty(i.kind as Kind), id: i.id, kind: i.kind as Kind, name: i.name, baseUrl: s('baseUrl'), enabled: i.enabled,
      projectKey: s('projectKey'), issueType: s('issueType', 'Bug'), auth: (s('auth', 'basic') as 'basic' | 'bearer'), email: s('email'), labels: list('labels'),
      project: s('project'), workItemType: s('workItemType', 'Bug'), areaPath: s('areaPath'), tags: list('tags'),
      projectId: c['projectId'] ? String(c['projectId']) : '', suiteId: c['suiteId'] ? String(c['suiteId']) : '', closeRun: c['closeRun'] === true,
    };
  }

  async save() {
    const f = this.form;
    const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
    const config = f.kind === 'testrail'
      ? { baseUrl: f.baseUrl.trim(), email: f.email.trim(), projectId: Number(f.projectId), suiteId: f.suiteId.trim() ? Number(f.suiteId) : null, closeRun: f.closeRun }
      : f.kind === 'jira'
      ? { baseUrl: f.baseUrl.trim(), projectKey: f.projectKey.trim().toUpperCase(), issueType: f.issueType.trim() || 'Bug', auth: f.auth,
          email: f.auth === 'basic' ? f.email.trim() : null, labels: list(f.labels) }
      : { baseUrl: f.baseUrl.trim(), project: f.project.trim(), workItemType: f.workItemType.trim() || 'Bug', areaPath: f.areaPath.trim() || null, tags: list(f.tags) };
    // an empty reference while editing keeps the stored one
    const credentialSecretRef = f.credentialSecretRef.trim() || (f.id ? undefined : null);
    try {
      if (f.id) await firstValueFrom(this.api.updateIntegration(f.id, { kind: f.kind, name: f.name.trim(), config, credentialSecretRef, enabled: f.enabled }));
      else await firstValueFrom(this.api.createIntegration({ kind: f.kind, name: f.name.trim(), config, credentialSecretRef, enabled: f.enabled }));
      this.reset();
      this.note.set(null);
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async check(i: Integration) {
    try {
      const r = await firstValueFrom(this.api.checkIntegration(i.id));
      this.note.set(r.ok ? this.i18n.t('Connected as {name}', { name: r.account ?? '?' }) : this.i18n.t('Connection failed: {error}', { error: r.error ?? '?' }));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  async remove(i: Integration) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: i.name }))) return;
    try { await firstValueFrom(this.api.deleteIntegration(i.id)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
