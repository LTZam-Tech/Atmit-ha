import { Component, EventEmitter, OnInit, Output, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { ElementInfo, LoginSettings, Project } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

interface MessageRow { key: string; en: string; ar: string }

/** Project settings, expected messages and the login form (backlog §3 stage "Data & Settings"). */
@Component({
  selector: 'at-project-settings',
  standalone: true,
  imports: [FormsModule, TranslatePipe, EmptyState, ErrorState],
  template: `
    <at-error [message]="error()" />
    @if (note()) { <p class="at-card" role="status">{{ note() }}</p> }

    <section class="at-card at-stack">
      <h2>{{ 'Project' | t }}</h2>
      <div class="at-row wrap">
        <div class="at-field at-grow"><label for="sn">{{ 'Name' | t }}</label><input id="sn" class="at-input" [(ngModel)]="s.name" [disabled]="!canEdit()"></div>
        <div class="at-field"><label for="st">{{ 'Test id attribute' | t }}</label><input id="st" class="at-input mono" [(ngModel)]="s.testIdAttribute" dir="ltr" [disabled]="!canEdit()"></div>
        <div class="at-field"><label for="sh">{{ 'Self-healing' | t }}</label>
          <select id="sh" class="at-select" [(ngModel)]="s.healingPolicy" [disabled]="!canEdit()">
            <option value="pass">{{ 'pass' | t }}</option><option value="flag">{{ 'flag' | t }}</option><option value="off">{{ 'off' | t }}</option></select></div>
        <label class="at-row"><input type="checkbox" [(ngModel)]="s.en" [disabled]="!canEdit()"> English</label>
        <label class="at-row"><input type="checkbox" [(ngModel)]="s.ar" [disabled]="!canEdit()"> العربية</label>
      </div>
      <div class="at-field"><label for="sd">{{ 'Description' | t }}</label><input id="sd" class="at-input" [(ngModel)]="s.description" [disabled]="!canEdit()"></div>
      <h3>{{ 'Run settings' | t }}</h3>
      <div class="at-row wrap">
        <div class="at-field"><label for="rw">{{ 'Parallel workers' | t }}</label><input id="rw" class="at-input small" type="number" min="1" max="16" [(ngModel)]="s.workers" [disabled]="!canEdit()"></div>
        <div class="at-field"><label for="rr">{{ 'Retries' | t }}</label><input id="rr" class="at-input small" type="number" min="0" max="3" [(ngModel)]="s.retries" [disabled]="!canEdit()"></div>
        <div class="at-field"><label for="rt">{{ 'Test timeout (s)' | t }}</label><input id="rt" class="at-input small" type="number" min="5" max="900" [(ngModel)]="s.testTimeout" [disabled]="!canEdit()"></div>
        <div class="at-field"><label for="ra">{{ 'Wait timeout (s)' | t }}</label><input id="ra" class="at-input small" type="number" min="1" max="120" [(ngModel)]="s.waitTimeout" [disabled]="!canEdit()"></div>
      </div>
      @if (canEdit()) { <div><button type="button" class="at-btn primary" [disabled]="!s.name.trim() || !(s.en || s.ar)" (click)="saveProject()">{{ 'Save' | t }}</button></div> }
    </section>

    <section class="at-card at-stack">
      <div class="at-row"><h2 class="at-grow">{{ 'Expected messages' | t }}</h2>
        <span class="at-muted">{{ 'Use in steps as' | t }} <code dir="ltr" ngNonBindable>{{msg.key}}</code></span></div>
      <table class="at-table">
        <thead><tr><th>{{ 'Key' | t }}</th><th>English</th><th>العربية</th><th></th></tr></thead>
        <tbody>
          @for (m of messages; track $index; let i = $index) {
            <tr>
              <td><input class="at-input mono" [(ngModel)]="m.key" dir="ltr" [disabled]="!canEdit()" [attr.aria-label]="'Key' | t"></td>
              <td><input class="at-input" [(ngModel)]="m.en" dir="ltr" [disabled]="!canEdit()" aria-label="English"></td>
              <td><input class="at-input" [(ngModel)]="m.ar" dir="rtl" [disabled]="!canEdit()" aria-label="العربية"></td>
              <td>@if (canEdit()) { <button type="button" class="at-btn danger" (click)="messages.splice(i, 1)" [attr.aria-label]="'Remove' | t">✕</button> }</td>
            </tr>
          } @empty { <tr><td colspan="4"><at-empty /></td></tr> }
        </tbody>
      </table>
      @if (canEdit()) {
        <div class="at-row"><button type="button" class="at-btn" (click)="messages.push({ key: '', en: '', ar: '' })">+ {{ 'Add message' | t }}</button>
          <button type="button" class="at-btn primary" (click)="saveMessages()">{{ 'Save' | t }}</button></div>
      }
    </section>

    <section class="at-card at-stack">
      <h2>{{ 'Login form' | t }}</h2>
      <p class="at-muted">{{ 'Used to sign test users in once and reuse their session in every test.' | t }}</p>
      <div class="at-row wrap">
        <div class="at-field"><label for="lp">{{ 'Page' | t }}</label>
          <select id="lp" class="at-select" [(ngModel)]="login.page" [disabled]="!canEdit()">
            <option value="">—</option>@for (pg of pageKeys(); track pg) { <option [value]="pg">{{ pg }}</option> }</select></div>
        @for (f of loginFields; track f) {
          <div class="at-field"><label>{{ f | t }}</label>
            <select class="at-select" [(ngModel)]="login[f]" [disabled]="!canEdit() || !login.page">
              <option value="">—</option>@for (e of elementsOf(login.page); track e) { <option [value]="e">{{ e }}</option> }</select></div>
        }
      </div>
      <div class="at-row wrap">
        <div class="at-field"><label for="ls">{{ 'Signed in when visible' | t }}</label>
          <input id="ls" class="at-input mono" list="at-all-elements" [(ngModel)]="login.successElement" dir="ltr" placeholder="inventory.title" [disabled]="!canEdit()"></div>
        <div class="at-field at-grow"><label for="lu">{{ 'or the address contains' | t }}</label>
          <input id="lu" class="at-input mono" [(ngModel)]="login.successUrl" dir="ltr" placeholder="/dashboard" [disabled]="!canEdit()"></div>
      </div>
      <datalist id="at-all-elements">@for (e of elements(); track $index) { <option [value]="e.page + '.' + e.element"></option> }</datalist>
      @if (canEdit()) {
        <div class="at-row"><button type="button" class="at-btn primary" [disabled]="!login.page" (click)="saveLogin()">{{ 'Save' | t }}</button>
          <button type="button" class="at-btn danger" (click)="removeLogin()">{{ 'Remove' | t }}</button></div>
      }
    </section>
  `,
  styles: [`section.at-card { margin-block-end: var(--at-space-4); } .wrap { flex-wrap: wrap; align-items: end; } .small { inline-size: 110px; }`],
})
export class ProjectSettingsComponent implements OnInit {
  readonly project = input.required<Project>();
  readonly canEdit = input(false);
  @Output() readonly saved = new EventEmitter<void>();
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected readonly elements = signal<ElementInfo[]>([]);
  protected readonly loginFields = ['username', 'password', 'submit'] as const;

  protected s = { name: '', description: '', testIdAttribute: '', healingPolicy: 'pass', en: true, ar: false,
    workers: null as number | null, retries: null as number | null, testTimeout: null as number | null, waitTimeout: null as number | null };
  protected messages: MessageRow[] = [];
  protected login: { page: string; username: string; password: string; submit: string; successElement: string; successUrl: string } =
    { page: '', username: '', password: '', submit: '', successElement: '', successUrl: '' };

  async ngOnInit() {
    const p = this.project();
    this.s = { name: p.name, description: p.description ?? '', testIdAttribute: p.testIdAttribute, healingPolicy: p.healingPolicy,
      en: p.languages.includes('en'), ar: p.languages.includes('ar'),
      workers: p.run.workers, retries: p.run.retries, testTimeout: p.run.testTimeoutSeconds, waitTimeout: p.run.waitTimeoutSeconds };
    try {
      const [elements, messages, login] = await Promise.all([
        firstValueFrom(this.api.elements(p.id)), firstValueFrom(this.api.messages(p.id)), firstValueFrom(this.api.login(p.id)),
      ]);
      this.elements.set(elements);
      const en = messages['en'] ?? {}, ar = messages['ar'] ?? {};
      const keys = [...new Set([...Object.keys(en), ...Object.keys(ar)])].sort();
      this.messages = keys.map((k) => ({ key: k, en: en[k] ?? '', ar: ar[k] ?? '' }));
      this.setLogin(login);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected pageKeys() { return [...new Set(this.elements().map((e) => e.page))]; }
  protected elementsOf(page: string) { return this.elements().filter((e) => e.page === page).map((e) => e.element); }

  private setLogin(l: LoginSettings) {
    this.login = { page: l.page ?? '', username: l.fields?.username ?? '', password: l.fields?.password ?? '', submit: l.fields?.submit ?? '',
      successElement: l.success?.element ?? '', successUrl: l.success?.urlContains ?? '' };
  }

  async saveProject() {
    const s = this.s;
    const n = (v: number | null) => (v === null || (v as unknown) === '' ? null : Number(v));
    try {
      await firstValueFrom(this.api.updateProject(this.project().id, {
        name: s.name.trim(), description: s.description.trim() || null, testIdAttribute: s.testIdAttribute.trim(), healingPolicy: s.healingPolicy,
        languages: [...(s.en ? ['en'] : []), ...(s.ar ? ['ar'] : [])],
        run: { workers: n(s.workers), retries: n(s.retries), testTimeoutSeconds: n(s.testTimeout), waitTimeoutSeconds: n(s.waitTimeout) },
      }));
      this.done();
      this.saved.emit();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async saveMessages() {
    const body: Record<string, Record<string, string>> = { en: {}, ar: {} };
    for (const m of this.messages) {
      if (!m.key.trim()) continue;
      if (m.en.trim()) body['en'][m.key.trim()] = m.en;
      if (m.ar.trim()) body['ar'][m.key.trim()] = m.ar;
    }
    try { await firstValueFrom(this.api.putMessages(this.project().id, body)); this.done(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async saveLogin() {
    const l = this.login;
    try {
      this.setLogin(await firstValueFrom(this.api.putLogin(this.project().id, {
        page: l.page, fields: { username: l.username, password: l.password, submit: l.submit },
        success: l.successElement || l.successUrl ? { element: l.successElement || null, urlContains: l.successUrl || null } : null,
      })));
      this.done();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async removeLogin() {
    if (!confirm(this.i18n.t('Remove the login form? Test users can then not be signed in automatically.'))) return;
    try { await firstValueFrom(this.api.deleteLogin(this.project().id)); this.setLogin({ page: null, fields: null, success: null }); this.done(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  private done() { this.error.set(null); this.note.set(this.i18n.t('Saved.')); setTimeout(() => this.note.set(null), 3000); }
}
