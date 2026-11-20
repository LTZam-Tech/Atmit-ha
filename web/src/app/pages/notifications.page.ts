import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Channel, Delivery, Project, Workspace } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

interface ChannelForm {
  id: string | null; name: string; kind: 'webhook' | 'slack' | 'teams'; projectId: string; target: string; signing: string;
  failed: boolean; passed: boolean; finished: boolean; enabled: boolean;
}

/** Where finished runs are announced: webhooks, Slack, Teams. Addresses are secrets-store references. */
@Component({
  selector: 'at-notifications',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, EmptyState, ErrorState],
  template: `
    <h1>{{ 'Notifications' | t }}</h1>
    <at-error [message]="error()" />
    @if (note()) { <p class="at-card" role="status">{{ note() }}</p> }

    <form class="at-card at-stack" (ngSubmit)="save()">
      <h2>{{ (form.id ? 'Edit channel' : 'New channel') | t }}</h2>
      <div class="at-row wrap">
        <div class="at-field"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="n" [(ngModel)]="form.name"></div>
        <div class="at-field"><label for="k">{{ 'Kind' | t }}</label>
          <select id="k" class="at-select" name="k" [(ngModel)]="form.kind" [disabled]="!!form.id">
            <option value="slack">Slack</option><option value="teams">Microsoft Teams</option><option value="webhook">{{ 'Webhook' | t }}</option>
          </select></div>
        <div class="at-field"><label for="p">{{ 'Project' | t }}</label>
          <select id="p" class="at-select" name="p" [(ngModel)]="form.projectId">
            <option value="">{{ 'All projects' | t }}</option>
            @for (p of projects(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
          </select></div>
      </div>
      <div class="at-row wrap">
        <div class="at-field at-grow"><label for="t">{{ 'Address reference' | t }}</label>
          <input id="t" class="at-input" name="t" [(ngModel)]="form.target" dir="ltr" placeholder="vault:env/SLACK_WEBHOOK_URL"></div>
        @if (form.kind === 'webhook') {
          <div class="at-field at-grow"><label for="s">{{ 'Signing secret reference (optional)' | t }}</label>
            <input id="s" class="at-input" name="s" [(ngModel)]="form.signing" dir="ltr" placeholder="vault:env/WEBHOOK_SECRET"></div>
        }
      </div>
      <fieldset class="at-row">
        <legend>{{ 'Send when' | t }}</legend>
        <label class="at-row"><input type="checkbox" name="ef" [(ngModel)]="form.failed"> {{ 'A run fails' | t }}</label>
        <label class="at-row"><input type="checkbox" name="ep" [(ngModel)]="form.passed"> {{ 'A run passes' | t }}</label>
        <label class="at-row"><input type="checkbox" name="ea" [(ngModel)]="form.finished"> {{ 'Any run finishes' | t }}</label>
      </fieldset>
      <label class="at-row"><input type="checkbox" name="on" [(ngModel)]="form.enabled"> {{ 'Switched on' | t }}</label>
      <div class="at-row">
        <button type="submit" class="at-btn primary" [disabled]="!form.name.trim() || (!form.id && !form.target.trim()) || !(form.failed || form.passed || form.finished)">{{ 'Save' | t }}</button>
        @if (form.id) { <button type="button" class="at-btn" (click)="reset()">{{ 'Cancel' | t }}</button> }
      </div>
      <p class="at-muted">{{ 'The webhook address works like a password, so only a reference to the secrets store is kept here.' | t }}</p>
    </form>

    <table class="at-table">
      <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Kind' | t }}</th><th>{{ 'Project' | t }}</th><th>{{ 'Send when' | t }}</th><th>{{ 'Status' | t }}</th><th></th></tr></thead>
      <tbody>
        @for (c of channels(); track c.id) {
          <tr>
            <td>{{ c.name }}</td>
            <td>{{ c.kind | t }}</td>
            <td>{{ projectName(c.projectId) }}</td>
            <td class="mono" dir="ltr">{{ c.events.join(', ') }}</td>
            <td>{{ (c.enabled ? 'Switched on' : 'Switched off') | t }}</td>
            <td>
              <button type="button" class="at-btn" (click)="test(c)">{{ 'Send a test' | t }}</button>
              <button type="button" class="at-btn" (click)="showDeliveries(c)">{{ 'Deliveries' | t }}</button>
              <button type="button" class="at-btn" (click)="edit(c)">{{ 'Edit' | t }}</button>
              <button type="button" class="at-btn danger" (click)="remove(c)">{{ 'Delete' | t }}</button>
            </td>
          </tr>
        } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
      </tbody>
    </table>

    @if (deliveriesOf(); as ch) {
      <h2>{{ 'Deliveries' | t }}: {{ ch.name }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'When' | t }}</th><th>{{ 'Run' | t }}</th><th>{{ 'Event' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Attempts' | t }}</th><th>{{ 'Details' | t }}</th></tr></thead>
        <tbody>
          @for (d of deliveries(); track d.id) {
            <tr>
              <td>{{ i18n.date(d.createdAt) }}</td>
              <td><a [routerLink]="['/runs', d.executionId]">{{ 'Open' | t }}</a></td>
              <td class="mono" dir="ltr">{{ d.event }}</td>
              <td>{{ d.status | t }}</td>
              <td>{{ i18n.number(d.attempts) }}</td>
              <td>{{ d.lastError ?? '' }}</td>
            </tr>
          } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
        </tbody>
      </table>
    }
  `,
  styles: [`form.at-card { margin-block-end: var(--at-space-4); } .wrap { flex-wrap: wrap; align-items: end; } fieldset { border: 0; padding: 0; gap: var(--at-space-4); }`],
})
export class NotificationsPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly channels = signal<Channel[]>([]);
  protected readonly projects = signal<Project[]>([]);
  protected readonly deliveries = signal<Delivery[]>([]);
  protected readonly deliveriesOf = signal<Channel | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected form: ChannelForm = NotificationsPage.empty();

  private static empty(): ChannelForm {
    return { id: null, name: '', kind: 'slack', projectId: '', target: '', signing: '', failed: true, passed: false, finished: false, enabled: true };
  }

  async ngOnInit() {
    try {
      const workspaces: Workspace[] = await firstValueFrom(this.api.workspaces());
      const lists = await Promise.all(workspaces.map((w) => firstValueFrom(this.api.projects(w.key))));
      this.projects.set(lists.flat());
    } catch { /* the project filter falls back to "all projects" */ }
    await this.load();
  }

  private async load() {
    try { this.channels.set(await firstValueFrom(this.api.channels())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected projectName(id: string | null) {
    return id ? (this.projects().find((p) => p.id === id)?.name ?? id) : this.i18n.t('All projects');
  }

  protected reset() { this.form = NotificationsPage.empty(); }

  protected edit(c: Channel) {
    this.form = { id: c.id, name: c.name, kind: c.kind, projectId: c.projectId ?? '', target: '', signing: '',
      failed: c.events.includes('run.failed'), passed: c.events.includes('run.passed'), finished: c.events.includes('run.finished'), enabled: c.enabled };
  }

  async save() {
    const f = this.form;
    const events = [...(f.failed ? ['run.failed'] : []), ...(f.passed ? ['run.passed'] : []), ...(f.finished ? ['run.finished'] : [])];
    const body = {
      name: f.name.trim(), kind: f.kind, projectId: f.projectId || null, events, enabled: f.enabled,
      ...(f.target.trim() ? { targetSecretRef: f.target.trim() } : {}),
      ...(f.kind === 'webhook' && f.signing.trim() ? { signingSecretRef: f.signing.trim() } : {}),
    };
    try {
      if (f.id) await firstValueFrom(this.api.updateChannel(f.id, body));
      else await firstValueFrom(this.api.createChannel(body));
      this.reset();
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async test(c: Channel) {
    try {
      const r = await firstValueFrom(this.api.testChannel(c.id));
      this.note.set(r.ok ? this.i18n.t('Test message sent to {name}', { name: c.name }) : this.i18n.t('Could not send: {error}', { error: r.error ?? '?' }));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  async showDeliveries(c: Channel) {
    try { this.deliveries.set(await firstValueFrom(this.api.deliveries(c.id))); this.deliveriesOf.set(c); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async remove(c: Channel) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: c.name }))) return;
    try {
      await firstValueFrom(this.api.deleteChannel(c.id));
      if (this.deliveriesOf()?.id === c.id) this.deliveriesOf.set(null);
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }
}
