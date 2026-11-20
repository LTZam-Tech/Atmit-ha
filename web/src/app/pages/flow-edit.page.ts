import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { Session } from '../core/session';
import { I18n, TranslatePipe } from '../core/i18n';
import { TabsKeyboard } from '../core/tabs.directive';
import type { CaseSummary, TestUser, WorkflowSummary } from '../core/models';
import { ErrorState } from '../core/states';

interface FlowStepRow { case: string; row: string; as: string; start: '' | 'open' | 'continue'; rest: Record<string, unknown> }

/** Workflow editor: test cases chained in one browser session (0.1.0 flows/*.flow.yml), sent for review (ADR-0007). */
@Component({
  selector: 'at-flow-edit',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, TabsKeyboard, ErrorState],
  template: `
    <div class="at-row">
      <h1 class="at-grow">{{ (isNew() ? 'New workflow' : 'Workflow') | t }}
        @if (!isNew()) { <span class="mono at-muted">{{ flowKey() }}</span> }
        @if (version()) { <span class="at-badge">v{{ version() }}</span> }</h1>
      <a class="at-btn" [routerLink]="['/projects', projectId()]">{{ 'Back' | t }}</a>
    </div>
    <at-error [message]="error()" />

    <nav class="at-tabs" role="tablist">
      <a href="#" role="tab" [class.active]="tab() === 'builder'" [attr.aria-selected]="tab() === 'builder'" (click)="$event.preventDefault(); showBuilder()">{{ 'Steps' | t }}</a>
      <a href="#" role="tab" [class.active]="tab() === 'json'" [attr.aria-selected]="tab() === 'json'" (click)="$event.preventDefault(); showJson()">JSON</a>
    </nav>

    @if (tab() === 'builder') {
      <section class="at-card at-stack">
        <div class="at-row wrap">
          @if (isNew()) {
            <div class="at-field"><label for="fk">{{ 'File name' | t }}</label><input id="fk" class="at-input mono" [(ngModel)]="key" dir="ltr" placeholder="order-journey"></div>
          }
          <div class="at-field at-grow"><label for="ft">{{ 'Name' | t }}</label><input id="ft" class="at-input" [(ngModel)]="title"></div>
          <div class="at-field"><label for="fm">{{ 'Module' | t }}</label><input id="fm" class="at-input" [(ngModel)]="module"></div>
          <div class="at-field"><label for="fg">{{ 'Tags (comma separated)' | t }}</label><input id="fg" class="at-input mono" [(ngModel)]="tags" dir="ltr" placeholder="@e2e"></div>
        </div>
        <div class="at-field"><label for="fd">{{ 'Description' | t }}</label><input id="fd" class="at-input" [(ngModel)]="description"></div>
      </section>

      <section class="at-card at-stack">
        <p class="at-muted">{{ 'A workflow chains test cases in one browser session; each case continues where the previous one ended.' | t }}</p>
        <ol class="steps">
          @for (s of steps; track $index; let i = $index) {
            <li class="at-row wrap step">
              <span class="num">{{ i + 1 }}</span>
              <select class="at-select at-grow" [(ngModel)]="s.case" [attr.aria-label]="'Test case' | t">
                <option value="">—</option>
                @for (c of cases(); track c.key) { <option [value]="c.key">{{ c.title }} ({{ c.key }})</option> }
              </select>
              <input class="at-input mono row" [(ngModel)]="s.row" dir="ltr" [placeholder]="'row (optional)' | t" [attr.aria-label]="'Row' | t">
              <select class="at-select" [(ngModel)]="s.as" [attr.aria-label]="'as' | t">
                <option value="">{{ 'same user' | t }}</option><option value="none">{{ 'Signed out' | t }}</option>
                @for (u of users(); track u.key) { <option [value]="u.key">{{ u.key }}</option> }
              </select>
              <select class="at-select" [(ngModel)]="s.start" [attr.aria-label]="'Start' | t">
                <option value="">{{ 'Start: default' | t }}</option><option value="open">{{ 'Start: open its page' | t }}</option><option value="continue">{{ 'Start: continue here' | t }}</option>
              </select>
              <span class="tools">
                <button type="button" class="at-btn icon" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move up' | t">↑</button>
                <button type="button" class="at-btn icon" [disabled]="i === steps.length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move down' | t">↓</button>
                <button type="button" class="at-btn icon danger" (click)="steps.splice(i, 1)" [attr.aria-label]="'Remove' | t">✕</button>
              </span>
            </li>
          }
        </ol>
        <div><button type="button" class="at-btn" (click)="steps.push({ case: '', row: '', as: '', start: '', rest: {} })">+ {{ 'Add step' | t }}</button></div>
      </section>
    } @else {
      <div class="at-field">
        <label for="json">{{ 'Content (JSON, the workflow file as in 0.1.0)' | t }}</label>
        <textarea id="json" class="editor" dir="ltr" spellcheck="false" [(ngModel)]="jsonText"></textarea>
      </div>
    }

    <div class="at-row submit">
      <input class="at-input at-grow" [(ngModel)]="changeTitle" [placeholder]="'Describe the change' | t" [attr.aria-label]="'Describe the change' | t">
      @if (session.can('project.edit')) {
        <button type="button" class="at-btn primary" [disabled]="busy() || !changeTitle.trim()" (click)="submit()">{{ 'Send for review' | t }}</button>
      } @else { <span class="at-muted">{{ 'You can read this, but editing needs the project.edit permission.' | t }}</span> }
    </div>
  `,
  styles: [`
    section.at-card { margin-block: var(--at-space-4); }
    .wrap { flex-wrap: wrap; align-items: end; }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--at-space-2); }
    .step { padding: var(--at-space-2); border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); align-items: center; }
    .num { inline-size: 24px; text-align: center; color: var(--at-color-muted); } .row { inline-size: 140px; }
    .tools { display: flex; gap: 2px; } .icon { padding-inline: 8px; }
    .editor { inline-size: 100%; min-block-size: 360px; font-family: var(--at-font-mono); font-size: 13px; padding: var(--at-space-3);
      border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); background: var(--at-color-surface); color: var(--at-color-text); }
    .submit { margin-block-start: var(--at-space-4); }
  `],
})
export class FlowEditPage {
  readonly projectId = input.required<string>();
  readonly flowKey = input<string | undefined>(undefined);
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  protected readonly isNew = computed(() => !this.flowKey());
  protected readonly version = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly tab = signal<'builder' | 'json'>('builder');
  protected readonly cases = signal<CaseSummary[]>([]);
  protected readonly users = signal<TestUser[]>([]);
  private readonly existing = signal<WorkflowSummary[]>([]);

  protected key = '';
  protected title = '';
  protected description = '';
  protected module = '';
  protected tags = '';
  protected steps: FlowStepRow[] = [];
  protected jsonText = '';
  protected changeTitle = '';
  private original: Record<string, unknown> = {};

  constructor() {
    effect(() => { void this.load(this.projectId(), this.flowKey()); });
  }

  private async load(projectId: string, key: string | undefined) {
    this.error.set(null);
    this.tab.set('builder');
    this.version.set(null);
    try {
      const [cases, users, flows] = await Promise.all([
        firstValueFrom(this.api.cases(projectId)), firstValueFrom(this.api.testUsers(projectId)), firstValueFrom(this.api.flows(projectId)),
      ]);
      this.cases.set(cases); this.users.set(users); this.existing.set(flows);
    } catch (e) { this.error.set(problemText(e)); }
    if (!key) { this.fromContent({ flow: '', steps: [] }); return; }
    try {
      const c = await firstValueFrom(this.api.flowContent(projectId, key));
      this.version.set(c.version);
      this.fromContent(c.content);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected move(i: number, by: number) { const [s] = this.steps.splice(i, 1); this.steps.splice(i + by, 0, s); }

  private fromContent(c: Record<string, unknown>) {
    this.original = structuredClone(c);
    const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
    this.key = this.flowKey() ?? '';
    this.title = s('flow'); this.description = s('description'); this.module = s('module');
    this.tags = Array.isArray(c['tags']) ? (c['tags'] as string[]).join(', ') : '';
    this.steps = (Array.isArray(c['steps']) ? c['steps'] : []).map((x) => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const v = (k: string) => (o[k] === undefined ? '' : String(o[k]));
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !['case', 'row', 'as', 'start'].includes(k)));
      return { case: v('case').replace(/\.case\.yml$/, ''), row: v('row'), as: v('as'), start: (['open', 'continue'].includes(v('start')) ? v('start') : '') as FlowStepRow['start'], rest };
    });
  }

  private toContent(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.original, flow: this.title.trim() };
    const set = (k: string, v: unknown) => { if (v === '' || (Array.isArray(v) && !v.length)) delete out[k]; else out[k] = v; };
    set('description', this.description.trim());
    set('module', this.module.trim());
    set('tags', this.tags.split(',').map((t) => t.trim()).filter(Boolean));
    const problems: string[] = [];
    out['steps'] = this.steps.map((s, i) => {
      if (!s.case) problems.push(this.i18n.t('Step {n} needs a case', { n: i + 1 }));
      return { case: s.case, ...(s.row.trim() ? { row: s.row.trim() } : {}), ...(s.as ? { as: s.as } : {}), ...(s.start ? { start: s.start } : {}), ...s.rest };
    });
    if (!this.title.trim()) problems.push(this.i18n.t('The workflow needs a name'));
    if (!this.steps.length) problems.push(this.i18n.t('Add at least one step'));
    if (problems.length) throw new Error(problems.join('\n'));
    return out;
  }

  protected showJson() {
    try { this.jsonText = JSON.stringify(this.toContent(), null, 2); this.tab.set('json'); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }

  protected showBuilder() {
    if (this.tab() === 'builder') return;
    try { this.fromContent(JSON.parse(this.jsonText)); this.tab.set('builder'); this.error.set(null); }
    catch (e) { this.error.set((e as Error).message); }
  }

  async submit() {
    let content: Record<string, unknown>;
    try { content = this.tab() === 'json' ? JSON.parse(this.jsonText) : this.toContent(); }
    catch (e) { this.error.set((e as Error).message); return; }
    const key = this.isNew() ? this.key.trim() : this.flowKey()!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(key)) { this.error.set(this.i18n.t('The file name uses letters, digits, ".", "_" and "-".')); return; }
    if (this.isNew() && this.existing().some((f) => f.key === key)) { this.error.set(this.i18n.t('A workflow with this file name already exists.')); return; }
    this.busy.set(true);
    try {
      const set = await firstValueFrom(this.api.submitChangeSet(this.projectId(), {
        title: this.changeTitle.trim(), source: 'central',
        items: [{ assetType: 'workflow', key, baseVersion: this.isNew() ? null : this.version(), content }],
      }));
      await this.router.navigate(['/change-sets', set.id]);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
