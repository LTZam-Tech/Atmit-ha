import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { Session } from '../core/session';
import { I18n, TranslatePipe } from '../core/i18n';
import { TabsKeyboard } from '../core/tabs.directive';
import {
  KEYS, RESERVED_ROW_KEYS, WEB_ACTIONS, bodyActions, dataFieldsUsed, emptyStep, parseStep, serializeStep, type ActionSpec, type BuilderStep, type Engine,
} from '../core/actions';
import type { CaseSummary, ElementInfo, TestUser } from '../core/models';
import { fieldCases, fieldDefOf, validValue, type FieldCase, type FieldDef } from '../core/datagen';
import { EmptyState, ErrorState } from '../core/states';

interface Meta {
  key: string; title: string; description: string; module: string; engine: Engine; type: '' | 'positive' | 'negative';
  vus: string; duration: string; rampUp: string; p95: string; errorRate: string; minRps: string;
  page: string; url: string; user: string; tags: string; dependsOn: string[]; continueCase: string; continueRow: string;
}
type Row = Record<string, unknown>;
interface Outcome { name: string; steps: BuilderStep[] }
/** a field the steps type into or choose from: its data column and the element that receives it */
interface DataField { column: string; page: string; element: string; ref: string }

/**
 * No-code Test Builder (backlog §3): a case as steps, expected outcomes and data rows, written in the engine's own
 * 0.1.0 shape and sent for review as a change set (ADR-0007). The JSON tab shows the same case as text.
 */
@Component({
  selector: 'at-case-builder',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, TabsKeyboard, EmptyState, ErrorState],
  template: `
    <div class="at-row">
      <h1 class="at-grow">{{ (isNew() ? 'New test case' : 'Test case') | t }}
        @if (!isNew()) { <span class="mono at-muted">{{ caseKey() }}</span> }
        @if (version()) { <span class="at-badge">v{{ version() }}</span> }</h1>
      <a class="at-btn" [routerLink]="['/projects', projectId()]">{{ 'Back' | t }}</a>
    </div>
    <at-error [message]="error()" />

    <nav class="at-tabs" role="tablist">
      <a href="#" role="tab" [class.active]="tab() === 'builder'" [attr.aria-selected]="tab() === 'builder'" (click)="$event.preventDefault(); showBuilder()">{{ 'Builder' | t }}</a>
      <a href="#" role="tab" [class.active]="tab() === 'json'" [attr.aria-selected]="tab() === 'json'" (click)="$event.preventDefault(); showJson()">JSON</a>
    </nav>

    <datalist id="at-elements">@for (e of elements(); track $index) { <option [value]="e.page + '.' + e.element">{{ e.description ?? e.control ?? '' }}</option> }</datalist>
    <datalist id="at-pages">@for (p of pageKeys(); track p) { <option [value]="p"></option> }</datalist>
    <datalist id="at-values">@for (v of valueHints(); track v) { <option [value]="v"></option> }</datalist>
    <datalist id="at-keys">@for (k of keys; track k) { <option [value]="k"></option> }</datalist>

    @if (tab() === 'builder') {
      <section class="at-card at-stack">
        <h2>{{ 'About this case' | t }}</h2>
        <div class="at-row wrap">
          @if (isNew()) {
            <div class="at-field"><label for="k">{{ 'File name' | t }}</label><input id="k" class="at-input mono" [(ngModel)]="meta.key" dir="ltr" placeholder="login-valid-user"></div>
          }
          <div class="at-field at-grow"><label for="t">{{ 'Name' | t }}</label><input id="t" class="at-input" [(ngModel)]="meta.title"></div>
          <div class="at-field"><label for="m">{{ 'Module' | t }}</label><input id="m" class="at-input" [(ngModel)]="meta.module"></div>
          <div class="at-field"><label for="e">{{ 'Engine' | t }}</label>
            <select id="e" class="at-select" [(ngModel)]="meta.engine" (ngModelChange)="engineChanged()"><option value="web">{{ 'web' | t }}</option><option value="api">{{ 'api' | t }}</option><option value="mobile">{{ 'mobile' | t }}</option><option value="performance">{{ 'performance' | t }}</option></select></div>
          <div class="at-field"><label for="ty">{{ 'Type' | t }}</label>
            <select id="ty" class="at-select" [(ngModel)]="meta.type"><option value="">—</option><option value="positive">{{ 'positive' | t }}</option><option value="negative">{{ 'negative' | t }}</option></select></div>
        </div>
        <div class="at-field"><label for="d">{{ 'Description' | t }}</label><input id="d" class="at-input" [(ngModel)]="meta.description"></div>
        @if (meta.engine === 'performance') {
          <div class="at-row wrap">
            <div class="at-field"><label for="lv">{{ 'Virtual users' | t }}</label><input id="lv" class="at-input mono small" type="number" min="1" [(ngModel)]="meta.vus"></div>
            <div class="at-field"><label for="ld">{{ 'Duration' | t }}</label><input id="ld" class="at-input mono small" [(ngModel)]="meta.duration" dir="ltr" placeholder="2m"></div>
            <div class="at-field"><label for="lr">{{ 'Ramp-up' | t }}</label><input id="lr" class="at-input mono small" [(ngModel)]="meta.rampUp" dir="ltr" placeholder="30s"></div>
            <div class="at-field"><label for="t95">{{ 'p95 below (ms)' | t }}</label><input id="t95" class="at-input mono small" type="number" min="1" [(ngModel)]="meta.p95"></div>
            <div class="at-field"><label for="ter">{{ 'Errors at most (0–1)' | t }}</label><input id="ter" class="at-input mono small" [(ngModel)]="meta.errorRate" dir="ltr" placeholder="0.01"></div>
            <div class="at-field"><label for="trps">{{ 'Requests/s at least' | t }}</label><input id="trps" class="at-input mono small" type="number" min="0" [(ngModel)]="meta.minRps"></div>
          </div>
          <p class="at-muted">{{ 'The load only targets the address of the environment itself, within the limits the organisation approved.' | t }}</p>
        }
        @if (meta.engine === 'mobile') {
          <p class="at-muted">{{ 'Mobile cases run on an agent with the mobile engine, on the device and app set in the mobile settings of the project (Appium).' | t }}</p>
        }
        <div class="at-row wrap">
          @if (meta.engine === 'web') {
            <div class="at-field"><label for="sp">{{ 'Start page' | t }}</label><input id="sp" class="at-input mono" list="at-pages" [(ngModel)]="meta.page" dir="ltr"></div>
            <div class="at-field"><label for="su">{{ 'Start as user' | t }}</label>
              <select id="su" class="at-select" [(ngModel)]="meta.user">
                <option value="">{{ 'The page decides' | t }}</option><option value="none">{{ 'Signed out' | t }}</option>
                @for (u of users(); track u.key) { <option [value]="u.key">{{ u.key }}</option> }
              </select></div>
          }
          <div class="at-field at-grow"><label for="url">{{ 'Start address (optional)' | t }}</label><input id="url" class="at-input mono" [(ngModel)]="meta.url" dir="ltr" placeholder="/orders/new"></div>
          <div class="at-field"><label for="tg">{{ 'Tags (comma separated)' | t }}</label><input id="tg" class="at-input mono" [(ngModel)]="meta.tags" dir="ltr" placeholder="@smoke"></div>
        </div>
        <div class="at-row wrap">
          <div class="at-field"><label for="dep">{{ 'Runs after' | t }}</label>
            <select id="dep" class="at-select" multiple size="3" [(ngModel)]="meta.dependsOn">
              @for (c of otherCases(); track c.key) { <option [value]="c.key">{{ c.title }}</option> }
            </select></div>
          <div class="at-field"><label for="cc">{{ 'Continue from case' | t }}</label>
            <select id="cc" class="at-select" [(ngModel)]="meta.continueCase">
              <option value="">—</option>
              @for (c of otherCases(); track c.key) { <option [value]="c.key">{{ c.title }}</option> }
            </select></div>
          @if (meta.continueCase) {
            <div class="at-field"><label for="cr">{{ 'Row' | t }}</label><input id="cr" class="at-input mono" [(ngModel)]="meta.continueRow" dir="ltr" placeholder="TC-001"></div>
          }
        </div>
      </section>

      <section class="at-card at-stack">
        <h2>{{ 'Steps' | t }} <span class="at-muted">{{ 'shared by every data row' | t }}</span></h2>
        <ng-container *ngTemplateOutlet="stepList; context: { $implicit: steps }"></ng-container>
      </section>

      <section class="at-card at-stack">
        <div class="at-row"><h2 class="at-grow">{{ 'Expected results' | t }} <span class="at-muted">{{ 'chosen per row by its outcome' | t }}</span></h2>
          <button type="button" class="at-btn" (click)="addOutcome()">{{ 'Add outcome' | t }}</button></div>
        @for (o of outcomes; track $index; let oi = $index) {
          <div class="outcome">
            <div class="at-row"><input class="at-input mono" [(ngModel)]="o.name" [attr.aria-label]="'Outcome name' | t" dir="ltr">
              <span class="at-grow"></span><button type="button" class="at-btn danger" (click)="outcomes.splice(oi, 1)">{{ 'Remove' | t }}</button></div>
            <ng-container *ngTemplateOutlet="stepList; context: { $implicit: o.steps }"></ng-container>
          </div>
        }
      </section>

      <section class="at-card at-stack">
        <div class="at-row"><h2 class="at-grow">{{ 'Test data' | t }} <span class="at-muted">{{ 'one test per row' | t }}</span></h2>
          <input class="at-input mono" [(ngModel)]="newColumn" [placeholder]="'new column' | t" dir="ltr" [attr.aria-label]="'new column' | t">
          <button type="button" class="at-btn" [disabled]="!validColumn()" (click)="addColumn()">{{ 'Add column' | t }}</button>
          <button type="button" class="at-btn" (click)="addRow()">{{ 'Add row' | t }}</button></div>
        <div class="grid-wrap">
          <table class="at-table data">
            <thead><tr><th>id</th><th>{{ 'Title' | t }}</th><th>{{ 'Type' | t }}</th><th>{{ 'Outcome' | t }}</th>
              @for (c of columns(); track c) { <th class="mono" dir="ltr">{{ c }}</th> }<th>{{ 'Skip' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (r of rows; track $index; let ri = $index) {
                <tr>
                  <td><input class="at-input mono cell" [(ngModel)]="r['id']" dir="ltr" [attr.aria-label]="'id'"></td>
                  <td><input class="at-input cell" [(ngModel)]="r['title']" [attr.aria-label]="'Title' | t"></td>
                  <td><select class="at-select" [(ngModel)]="r['type']" [attr.aria-label]="'Type' | t"><option [ngValue]="undefined">—</option><option value="positive">{{ 'positive' | t }}</option><option value="negative">{{ 'negative' | t }}</option></select></td>
                  <td><select class="at-select" [(ngModel)]="r['outcome']" [attr.aria-label]="'Outcome' | t"><option [ngValue]="undefined">—</option>@for (o of outcomes; track $index) { <option [value]="o.name">{{ o.name }}</option> }</select></td>
                  @for (c of columns(); track c) { <td><input class="at-input mono cell" [(ngModel)]="r[c]" list="at-values" dir="ltr" [attr.aria-label]="c"></td> }
                  <td><input type="checkbox" [(ngModel)]="r['skip']" [attr.aria-label]="'Skip' | t"></td>
                  <td><button type="button" class="at-btn danger" (click)="rows.splice(ri, 1)" [attr.aria-label]="'Remove' | t">✕</button></td>
                </tr>
              } @empty { <tr><td [attr.colspan]="6 + columns().length"><at-empty text="No rows: the case runs once." /></td></tr> }
            </tbody>
          </table>
        </div>
        @if (meta.engine === 'web') {
          <details class="gen" [open]="proposals().length > 0">
            <summary>{{ 'Generate rows' | t }} <span class="at-muted">{{ 'boundary, negative and security values from the page rules' | t }}</span></summary>
            @if (dataFields().length === 0) {
              <p class="at-muted">{{ 'Add a "Type into" or "Select from dropdown" step on a page element first.' | t }}</p>
            } @else {
              <div class="at-row">
                <select class="at-select" [(ngModel)]="genField" [attr.aria-label]="'Field' | t">
                  @for (f of dataFields(); track f.ref + f.column) { <option [value]="f.column">{{ f.column }} — {{ f.ref }}</option> }
                </select>
                <button type="button" class="at-btn" [disabled]="busy() || !genField" (click)="propose()">{{ 'Propose rows' | t }}</button>
              </div>
            }
            @if (proposals().length) {
              <table class="at-table">
                <thead><tr><th></th><th>{{ 'Value' | t }}</th><th>{{ 'Type' | t }}</th><th>{{ 'Technique' | t }}</th><th>{{ 'Reason' | t }}</th></tr></thead>
                <tbody>
                  @for (c of proposals(); track $index) {
                    <tr>
                      <td><input type="checkbox" [(ngModel)]="c.checked" [attr.aria-label]="c.why"></td>
                      <td class="mono" dir="ltr">{{ c.value === '' ? '(' + ('empty' | t) + ')' : c.value }}</td>
                      <td>{{ c.type | t }}</td><td>{{ c.technique }}</td><td>{{ c.why }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              <div class="at-row">
                <button type="button" class="at-btn primary" [disabled]="!ticked()" (click)="addProposed()">{{ 'Add {n} row(s)' | t: { n: ticked() } }}</button>
                <button type="button" class="at-btn" (click)="proposals.set([])">{{ 'Cancel' | t }}</button>
              </div>
            }
          </details>
        }
      </section>
    } @else {
      <div class="at-field">
        <label for="json">{{ 'Content (JSON, the case file as in 0.1.0)' | t }}</label>
        <textarea id="json" class="editor" dir="ltr" spellcheck="false" [(ngModel)]="jsonText"></textarea>
      </div>
    }

    <div class="at-row submit">
      <input class="at-input at-grow" [(ngModel)]="changeTitle" [placeholder]="'Describe the change' | t" [attr.aria-label]="'Describe the change' | t">
      @if (session.can('project.edit')) {
        <button type="button" class="at-btn primary" [disabled]="busy() || !changeTitle.trim()" (click)="submit()">{{ 'Send for review' | t }}</button>
      } @else { <span class="at-muted">{{ 'You can read this, but editing needs the project.edit permission.' | t }}</span> }
    </div>

    <ng-template #stepList let-list>
      <ol class="steps">
        @for (s of $any(list); track $index; let i = $index) {
          <li class="step" [class.bad]="s.problem">
            <span class="num">{{ i + 1 }}</span>
            @if (s.raw) {
              <code class="at-grow" dir="ltr">{{ json(s.raw) }}</code><span class="at-error">{{ s.problem }}</span>
            } @else {
              <select class="at-select action" [(ngModel)]="s.action" [attr.aria-label]="'Action' | t">
                @if (meta.engine !== 'web') { @for (a of bodyActionList(); track a[0]) { <option [value]="a[0]">{{ a[1].label | t }}</option> } }
                @else { @for (g of webGroups; track g.kind) { <optgroup [label]="g.kind | t">@for (a of g.actions; track a[0]) { <option [value]="a[0]">{{ a[1].label | t }}</option> }</optgroup> } }
              </select>
              @if (meta.engine !== 'web') {
                <input class="at-input mono at-grow" [(ngModel)]="s.body" dir="ltr" [placeholder]="apiExample(s.action)" [attr.aria-label]="'Value' | t">
              } @else {
                @switch (spec(s.action)?.target) {
                  @case ('page') { <input class="at-input mono" list="at-pages" [(ngModel)]="s.page" dir="ltr" [placeholder]="'page' | t" [attr.aria-label]="'Page' | t"> }
                  @case ('url') { <input class="at-input mono at-grow" [(ngModel)]="s.url" dir="ltr" placeholder="/path" [attr.aria-label]="'Address' | t"> }
                  @case ('none') { }
                  @default { <input class="at-input mono el" list="at-elements" [(ngModel)]="s.element" dir="ltr" placeholder="page.element" [attr.aria-label]="'Element' | t"> }
                }
                @if (spec(s.action)?.value || spec(s.action)?.valueOptional) {
                  <input class="at-input mono at-grow" [attr.list]="s.action === 'press' ? 'at-keys' : 'at-values'" [(ngModel)]="s.value" dir="ltr" [placeholder]="(s.action === 'press' ? 'key' : 'value') | t" [attr.aria-label]="'Value' | t">
                }
                @if (spec(s.action)?.match) {
                  <select class="at-select" [(ngModel)]="s.matcher" [attr.aria-label]="'Match' | t"><option value="equals">{{ 'equals' | t }}</option><option value="contains">{{ 'contains' | t }}</option></select>
                  <input class="at-input mono at-grow" list="at-values" [(ngModel)]="s.expected" dir="ltr" [attr.aria-label]="'Expected' | t">
                }
                @if (spec(s.action)?.save) {
                  <input class="at-input mono" [(ngModel)]="s.as" dir="ltr" [placeholder]="'variable' | t" [attr.aria-label]="'Variable' | t">
                  <input class="at-input mono" [(ngModel)]="s.pattern" dir="ltr" [placeholder]="'pattern (optional)' | t" [attr.aria-label]="'Pattern' | t">
                }
              }
              <input class="at-input name" [(ngModel)]="s.name" [placeholder]="'step title (optional)' | t" [attr.aria-label]="'Step title' | t">
            }
            <span class="tools">
              <button type="button" class="at-btn icon" [disabled]="i === 0" (click)="move($any(list), i, -1)" [attr.aria-label]="'Move up' | t">↑</button>
              <button type="button" class="at-btn icon" [disabled]="i === $any(list).length - 1" (click)="move($any(list), i, 1)" [attr.aria-label]="'Move down' | t">↓</button>
              <button type="button" class="at-btn icon danger" (click)="$any(list).splice(i, 1)" [attr.aria-label]="'Remove' | t">✕</button>
            </span>
          </li>
        }
      </ol>
      <button type="button" class="at-btn" (click)="$any(list).push(newStep())">+ {{ 'Add step' | t }}</button>
    </ng-template>
  `,
  styles: [`
    section.at-card { margin-block: var(--at-space-4); }
    .small { inline-size: 110px; }
    .wrap { flex-wrap: wrap; align-items: end; }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--at-space-2); }
    .step { display: flex; flex-wrap: wrap; gap: var(--at-space-2); align-items: center; padding: var(--at-space-2); border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); }
    .step.bad { border-color: var(--at-color-bad); }
    .num { inline-size: 24px; text-align: center; color: var(--at-color-muted); font-variant-numeric: tabular-nums; }
    .action { min-inline-size: 190px; } .el { min-inline-size: 220px; } .name { inline-size: 200px; }
    .tools { display: flex; gap: 2px; margin-inline-start: auto; }
    .icon { padding-inline: 8px; }
    .outcome { border-inline-start: 3px solid var(--at-color-primary); padding-inline-start: var(--at-space-3); display: grid; gap: var(--at-space-2); }
    .grid-wrap { overflow-x: auto; }
    .cell { min-inline-size: 120px; }
    .editor { inline-size: 100%; min-block-size: 480px; font-family: var(--at-font-mono); font-size: 13px; padding: var(--at-space-3);
      border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); background: var(--at-color-surface); color: var(--at-color-text); }
    .gen { border-block-start: 1px solid var(--at-color-border); padding-block-start: var(--at-space-3); display: grid; gap: var(--at-space-2); }
    .gen summary { cursor: pointer; font-weight: 600; }
    .submit { margin-block-start: var(--at-space-4); position: sticky; inset-block-end: 0; background: var(--at-color-bg); padding-block: var(--at-space-3); }
  `],
})
export class CaseBuilderPage {
  readonly projectId = input.required<string>();
  /** absent on the "new case" route */
  readonly caseKey = input<string | undefined>(undefined);
  /** ?page=checkout: a new case starting on that page (from a run's findings) */
  readonly page = input<string | undefined>(undefined);
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  protected readonly i18n = inject(I18n);

  protected readonly isNew = computed(() => !this.caseKey());
  protected readonly version = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly tab = signal<'builder' | 'json'>('builder');
  protected readonly elements = signal<ElementInfo[]>([]);
  protected readonly users = signal<TestUser[]>([]);
  protected readonly cases = signal<CaseSummary[]>([]);
  /** rows proposed by the generator for one field (ticked ones are added to the data grid) */
  protected readonly proposals = signal<FieldCase[]>([]);
  protected genField = '';
  private readonly pageContents = new Map<string, Record<string, unknown>>();
  protected readonly pageKeys = computed(() => [...new Set(this.elements().map((e) => e.page))]);
  protected readonly otherCases = computed(() => this.cases().filter((c) => c.key !== this.caseKey()));
  private readonly columnsTick = signal(0);
  protected readonly keys = KEYS;
  protected bodyActionList() { return Object.entries(bodyActions(this.meta.engine)); }
  protected readonly webGroups = (['Navigate', 'Data entry', 'Click', 'Verify'] as const).map((kind) => ({
    kind, actions: Object.entries(WEB_ACTIONS).filter(([, a]) => a.kind === kind),
  }));

  protected meta: Meta = this.emptyMeta();
  /** the engine the steps were written for, to keep them when the engine changes */
  private previousEngine: Engine = 'web';
  protected steps: BuilderStep[] = [];
  protected outcomes: Outcome[] = [];
  protected rows: Row[] = [];
  protected jsonText = '';
  protected changeTitle = '';
  protected newColumn = '';
  private extraColumns: string[] = [];
  /** the case as loaded: keys the builder does not edit are kept */
  private original: Record<string, unknown> = {};

  constructor() {
    effect(() => { void this.load(this.projectId(), this.caseKey()); });
  }

  protected spec(action: string): ActionSpec | undefined { return WEB_ACTIONS[action]; }
  protected apiExample(action: string) { return bodyActions(this.meta.engine)[action]?.example ?? ''; }
  protected json(v: unknown) { return JSON.stringify(v); }
  protected newStep() { return emptyStep({ web: 'click', api: 'status', mobile: 'tap', performance: 'request' }[this.meta.engine]); }

  /** data columns: fields in the rows, fields the steps use ({{data.x}}), and columns added here */
  protected columns() {
    this.columnsTick();
    const fromRows = this.rows.flatMap((r) => Object.keys(r)).filter((k) => !RESERVED_ROW_KEYS.has(k));
    const used = dataFieldsUsed([this.safeSteps(this.steps), this.outcomes.map((o) => this.safeSteps(o.steps))]);
    return [...new Set([...fromRows, ...used, ...this.extraColumns])];
  }

  protected valueHints(): string[] {
    const vars = [...this.steps, ...this.outcomes.flatMap((o) => o.steps)].map((s) => s.as).filter(Boolean);
    return [
      ...this.columns().map((c) => `{{data.${c}}}`),
      ...this.users().flatMap((u) => [`{{user.${u.key}.username}}`, `{{user.${u.key}.password}}`]),
      ...vars.map((v) => `{{var.${v}}}`),
      '{{faker.person.firstName}}', '{{faker.person.lastName}}', '{{faker.internet.email}}', '{{faker.phone.number}}',
      '{{faker.string.alpha(10)}}', '{{faker.string.numeric(8)}}', '{{faker.date.past}}', '{{env.baseURL}}',
    ];
  }

  protected validColumn() { return /^[a-zA-Z]\w*$/.test(this.newColumn) && !RESERVED_ROW_KEYS.has(this.newColumn) && !this.columns().includes(this.newColumn); }
  protected addColumn() { this.extraColumns.push(this.newColumn); this.newColumn = ''; this.columnsTick.update((n) => n + 1); }
  /** fill / select / choose steps whose value is a data column ({{data.x}}), or else named after their element */
  protected dataFields(): DataField[] {
    const seen = new Map<string, DataField>();
    for (const st of [...this.steps, ...this.outcomes.flatMap((o) => o.steps)]) {
      if (st.raw || !['fill', 'select', 'choose'].includes(st.action) || !st.element.trim()) continue;
      const ref = st.element.trim();
      const dot = ref.indexOf('.');
      const page = dot > 0 ? ref.slice(0, dot) : this.meta.page;
      const element = (dot > 0 ? ref.slice(dot + 1) : ref).replace(/\(.*$/, '');
      const column = /\{\{\s*data\.(\w+)\s*\}\}/.exec(st.value)?.[1] ?? element;
      if (page && element && !seen.has(column)) seen.set(column, { column, page, element, ref });
    }
    const list = [...seen.values()];
    if (list.length && !list.some((f) => f.column === this.genField)) this.genField = list[0].column;
    return list;
  }

  protected ticked() { return this.proposals().filter((c) => c.checked).length; }

  private async defOf(f: DataField): Promise<FieldDef> {
    if (!this.pageContents.has(f.page)) {
      try { this.pageContents.set(f.page, (await firstValueFrom(this.api.pageContent(this.projectId(), f.page))).content); }
      catch { this.pageContents.set(f.page, {}); }
    }
    return fieldDefOf(this.pageContents.get(f.page), f.element);
  }

  /** a valid row first, then the boundary, format, required and security rows ported from the panel (fieldCases) */
  protected async propose() {
    const f = this.dataFields().find((x) => x.column === this.genField);
    if (!f) return;
    this.busy.set(true);
    try {
      const def = await this.defOf(f);
      this.proposals.set([
        { field: f.column, value: validValue(def), type: 'positive', technique: 'EP', why: `${f.column} with a valid value`, checked: true },
        ...fieldCases(f.column, def),
      ]);
      if (!def.control && !def.rules) this.error.set(this.i18n.t('The page has no rules for {element}: only general rows were proposed.', { element: f.ref }));
      else this.error.set(null);
    } finally { this.busy.set(false); }
  }

  /** each ticked proposal becomes a row: that field takes the proposed value, every other field a valid one */
  protected async addProposed() {
    const fields = this.dataFields();
    const valid: Record<string, string> = {};
    for (const f of fields) valid[f.column] = validValue(await this.defOf(f));
    const outcomeFor = (type: FieldCase['type']) => {
      const name = type === 'positive' ? 'success' : 'error';
      if (!this.outcomes.some((o) => o.name === name)) this.outcomes.push({ name, steps: [] });
      return name;
    };
    const used = new Set(this.rows.map((r) => String(r['id'] ?? '')));
    let n = this.rows.length;
    const nextId = () => { let id: string; do { id = `TC-${String(++n).padStart(3, '0')}`; } while (used.has(id)); used.add(id); return id; };
    for (const c of this.proposals().filter((x) => x.checked)) {
      this.rows.push({ id: nextId(), title: c.why, type: c.type, outcome: outcomeFor(c.type), ...valid, [c.field]: c.value });
    }
    this.proposals.set([]);
    this.columnsTick.update((x) => x + 1);
  }

  protected addRow() { this.rows.push({ id: `TC-${String(this.rows.length + 1).padStart(3, '0')}` }); }
  protected addOutcome() { this.outcomes.push({ name: this.outcomes.length ? `outcome${this.outcomes.length + 1}` : 'success', steps: [] }); }
  protected move(list: BuilderStep[], i: number, by: number) { const [s] = list.splice(i, 1); list.splice(i + by, 0, s); }
  protected engineChanged() {
    // steps of the previous engine cannot be shown as steps: keep them as raw rows rather than losing them
    const convert = (l: BuilderStep[]) => l.map((s) => s.raw ? s : { ...emptyStep(s.action), raw: this.tryRaw(s), problem: this.i18n.t('belongs to the other engine') });
    this.previousEngine = this.meta.engine;
    this.steps = convert(this.steps);
    this.outcomes.forEach((o) => (o.steps = convert(o.steps)));
  }

  private tryRaw(s: BuilderStep): Record<string, unknown> {
    try { return serializeStep(s, this.previousEngine); } catch { return { [s.action]: s.body || s.element || s.value }; }
  }

  private safeSteps(list: BuilderStep[]) { return list.map((s) => { try { return serializeStep(s, this.meta.engine); } catch { return {}; } }); }

  private emptyMeta(): Meta {
    return { key: '', title: '', description: '', module: '', engine: 'web', type: '', page: '', url: '', user: '', tags: '', dependsOn: [], continueCase: '', continueRow: '',
      vus: '10', duration: '1m', rampUp: '', p95: '', errorRate: '', minRps: '' };
  }

  private async load(projectId: string, key: string | undefined) {
    this.error.set(null);
    this.tab.set('builder');
    this.version.set(null);
    try {
      const [elements, users, cases] = await Promise.all([
        firstValueFrom(this.api.elements(projectId)), firstValueFrom(this.api.testUsers(projectId)), firstValueFrom(this.api.cases(projectId)),
      ]);
      this.elements.set(elements);
      this.users.set(users);
      this.cases.set(cases);
    } catch (e) { this.error.set(problemText(e)); }
    if (!key) {
      this.fromContent({ case: '', ...(this.page() ? { page: this.page() } : {}), steps: [], outcomes: { success: [] }, data: [] });
      return;
    }
    try {
      const c = await firstValueFrom(this.api.caseContent(projectId, key));
      this.version.set(c.version);
      this.fromContent(c.content);
    } catch (e) { this.error.set(problemText(e)); }
  }

  /** case content (0.1.0 shape) → builder state */
  private fromContent(content: Record<string, unknown>) {
    this.original = structuredClone(content);
    const s = (k: string) => (typeof content[k] === 'string' ? (content[k] as string) : '');
    const engine: Engine = (['api', 'mobile', 'performance'].includes(String(content['engine'])) ? content['engine'] : 'web') as Engine;
    this.previousEngine = engine;
    const load = (content['load'] ?? {}) as Record<string, unknown>;
    const limits = (content['thresholds'] ?? {}) as Record<string, unknown>;
    const v = (x: unknown) => (x === undefined || x === null ? '' : String(x));
    const cf = (content['continueFrom'] ?? {}) as Record<string, unknown>;
    this.meta = {
      key: this.caseKey() ?? '', title: s('case'), description: s('description'), module: s('module'), engine,
      type: (['positive', 'negative'].includes(String(content['type'])) ? content['type'] : '') as Meta['type'],
      page: s('page'), url: s('url'), user: s('user'),
      tags: Array.isArray(content['tags']) ? (content['tags'] as string[]).join(', ') : '',
      dependsOn: Array.isArray(content['dependsOn']) ? (content['dependsOn'] as string[]) : [],
      continueCase: typeof cf['case'] === 'string' ? String(cf['case']) : '', continueRow: typeof cf['row'] === 'string' ? String(cf['row']) : '',
      vus: v(load['vus']) || '10', duration: v(load['duration']) || (load['iterations'] ? '' : '1m'), rampUp: v(load['rampUp']),
      p95: v(limits['p95']), errorRate: v(limits['errorRate']), minRps: v(limits['minRps']),
    };
    this.steps = (Array.isArray(content['steps']) ? content['steps'] : []).map((x) => parseStep(x, engine));
    const outs = (content['outcomes'] && typeof content['outcomes'] === 'object' ? content['outcomes'] : {}) as Record<string, unknown>;
    this.outcomes = Object.entries(outs).map(([name, list]) => ({ name, steps: (Array.isArray(list) ? list : []).map((x) => parseStep(x, engine)) }));
    this.rows = (Array.isArray(content['data']) ? content['data'] : []).filter((r) => r && typeof r === 'object').map((r) => ({ ...(r as Row) }));
    this.extraColumns = [];
    this.columnsTick.update((n) => n + 1);
  }

  /** builder state → case content; keys the builder does not know stay as loaded */
  private toContent(): Record<string, unknown> {
    const m = this.meta;
    const out: Record<string, unknown> = { ...this.original };
    const set = (k: string, v: unknown) => { if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) delete out[k]; else out[k] = v; };
    out['case'] = m.title.trim();
    set('description', m.description.trim());
    set('module', m.module.trim());
    set('engine', m.engine === 'web' ? '' : m.engine);
    if (m.engine === 'performance') {
      const load: Record<string, unknown> = { ...((this.original['load'] as Record<string, unknown>) ?? {}), vus: Number(m.vus) || 1 };
      if (m.duration.trim()) { load['duration'] = m.duration.trim(); delete load['iterations']; }
      if (m.rampUp.trim()) load['rampUp'] = m.rampUp.trim(); else delete load['rampUp'];
      out['load'] = load;
      const limits: Record<string, unknown> = { ...((this.original['thresholds'] as Record<string, unknown>) ?? {}) };
      const num = (k: string, x: string) => { if (x.trim() === '') delete limits[k]; else limits[k] = Number(x); };
      num('p95', m.p95); num('errorRate', m.errorRate); num('minRps', m.minRps);
      set('thresholds', Object.keys(limits).length ? limits : '');
    } else { delete out['load']; delete out['thresholds']; }
    set('type', m.type);
    set('page', m.engine === 'web' ? m.page.trim() : '');
    set('user', m.engine === 'web' ? m.user : '');
    set('url', m.url.trim());
    set('tags', m.tags.split(',').map((t) => t.trim()).filter(Boolean));
    set('dependsOn', m.dependsOn);
    set('continueFrom', m.continueCase ? { case: m.continueCase, ...(m.continueRow.trim() ? { row: m.continueRow.trim() } : {}) } : '');

    const problems: string[] = [];
    const ser = (list: BuilderStep[], where: string) => list.map((s, i) => {
      try { return serializeStep(s, m.engine); } catch (e) { problems.push(`${where} ${i + 1}: ${(e as Error).message}`); return {}; }
    });
    out['steps'] = ser(this.steps, this.i18n.t('Step'));
    const outcomes: Record<string, unknown> = {};
    for (const o of this.outcomes) {
      const name = o.name.trim();
      if (!name) { problems.push(this.i18n.t('An outcome needs a name')); continue; }
      if (name in outcomes) problems.push(this.i18n.t('Outcome "{name}" appears twice', { name }));
      outcomes[name] = ser(o.steps, name);
    }
    set('outcomes', Object.keys(outcomes).length ? outcomes : '');
    out['data'] = this.rows.map((r) => {
      const clean: Row = {};
      for (const [k, v] of Object.entries(r)) {
        // an empty value is a real test value (e.g. a required field left blank): only unset cells are dropped
        if (v === undefined || v === null || (k === 'skip' && v === false)) continue;
        clean[k] = v;
      }
      return clean;
    });
    if (!(out['data'] as Row[]).length) delete out['data'];
    if (!m.title.trim()) problems.push(this.i18n.t('The case needs a name'));
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
    const key = this.isNew() ? this.meta.key.trim() : this.caseKey()!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(key)) { this.error.set(this.i18n.t('The file name uses letters, digits, ".", "_" and "-".')); return; }
    if (this.isNew() && this.cases().some((c) => c.key === key)) { this.error.set(this.i18n.t('A case with this file name already exists.')); return; }
    this.busy.set(true);
    try {
      const set = await firstValueFrom(this.api.submitChangeSet(this.projectId(), {
        title: this.changeTitle.trim(), source: 'central',
        items: [{ assetType: 'test_case', key, baseVersion: this.isNew() ? null : this.version(), content }],
      }));
      await this.router.navigate(['/change-sets', set.id]);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
