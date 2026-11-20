import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { EvidenceFile, ExecutionDetail, FiledIssue, Integration } from '../core/models';
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { StatusBadge } from './status-badge';
import { RunFindingsComponent } from './run-findings.component';
import { RunOutputComponent } from './run-output.component';
import { Session } from '../core/session';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

const ACTIVE = ['queued', 'assigned', 'running'];

/** One run: status, counts, each test with its category, error and self-healing (original failure kept). */
@Component({
  selector: 'at-run',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, StatusBadge, RunFindingsComponent, RunOutputComponent, ErrorState, LoadingState, EmptyState],
  template: `
    <at-error [message]="error()" />
    @if (detail(); as d) {
      <div class="at-row">
        <h1 class="at-grow">{{ 'Run' | t }} <at-status [status]="d.execution.status" /></h1>
        <a class="at-btn" [routerLink]="['/projects', d.execution.projectId]">{{ 'Back' | t }}</a>
        @if (active()) {
          <button type="button" class="at-btn danger" [disabled]="d.execution.cancelRequested || !session.can('execution.run')" (click)="cancel()">
            {{ (d.execution.cancelRequested ? 'Cancellation requested' : 'Cancel run') | t }}
          </button>
        }
      </div>
      <div class="grid">
        <div class="at-card"><div class="at-muted">{{ 'Total' | t }}</div><div class="big">{{ i18n.number(d.execution.counts?.total ?? d.results.length) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Passed' | t }}</div><div class="big ok">{{ i18n.number(d.execution.counts?.passed ?? count('passed')) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Failed' | t }}</div><div class="big bad">{{ i18n.number(d.execution.counts?.failed ?? count('failed')) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Flaky' | t }}</div><div class="big">{{ i18n.number(d.execution.counts?.flaky ?? 0) }}</div></div>
        <div class="at-card"><div class="at-muted">{{ 'Healed' | t }}</div><div class="big">{{ i18n.number(d.execution.counts?.healed ?? healedCount()) }}</div></div>
      </div>
      <p class="at-muted">
        {{ 'Environment' | t }}: <span class="mono">{{ d.execution.environment }}</span> ·
        {{ 'Engine' | t }}: {{ d.execution.engine | t }} · {{ 'Self-healing' | t }}: {{ d.execution.healingPolicy | t }} ·
        {{ 'Queued' | t }}: {{ i18n.date(d.execution.queuedAt) }} · {{ 'Finished' | t }}: {{ i18n.date(d.execution.finishedAt) }}
      </p>
      @if (d.execution.error) { <p class="at-alert">{{ d.execution.error }}</p> }
      @if (jobKind(); as k) {
        @if (!active()) { <at-run-output [executionId]="d.execution.id" [projectId]="d.execution.projectId" [kind]="k" /> }
        @else { <p class="at-muted" role="status">{{ (k === 'explore' ? 'Collecting pages…' : 'Exporting Playwright code…') | t }}</p> }
      }
      @if (preview(); as pv) {
        <div class="viewer" role="dialog" aria-modal="true" [attr.aria-label]="pv.name" (click)="closePreview()" (keydown.escape)="closePreview()" tabindex="-1">
          <figure (click)="$event.stopPropagation()">
            @if (pv.kind === 'video') { <video [src]="pv.url" controls autoplay></video> } @else { <img [src]="pv.url" [alt]="pv.name"> }
            <figcaption class="at-row"><span class="at-grow mono" dir="ltr">{{ pv.name }}</span>
              <a class="at-btn" [href]="pv.url" [attr.download]="pv.name">{{ 'Download' | t }}</a>
              <button type="button" class="at-btn" (click)="closePreview()">{{ 'Close' | t }}</button></figcaption>
          </figure>
        </div>
      }
      @if (!active() && session.can('execution.run') && count('failed') + count('timed_out') + count('interrupted') > 0 && trackers().length > 0) {
        <div class="at-card at-row defects">
          <span class="at-grow">{{ 'File the failed tests as defects' | t }}</span>
          <select class="at-select" [(ngModel)]="tracker" [attr.aria-label]="'Integration' | t">
            @for (i of trackers(); track i.id) { <option [value]="i.id">{{ i.name }}</option> }
          </select>
          <button type="button" class="at-btn primary" [disabled]="publishing()" (click)="publish()">{{ 'File defects' | t }}</button>
        </div>
      }
      @if (!active() && session.can('execution.run') && publishers().length > 0) {
        <div class="at-card at-row defects">
          <span class="at-grow">{{ 'Publish the results to test management' | t }}</span>
          <select class="at-select" [(ngModel)]="publisher" [attr.aria-label]="'Integration' | t">
            @for (i of publishers(); track i.id) { <option [value]="i.id">{{ i.name }}</option> }
          </select>
          <button type="button" class="at-btn" [disabled]="publishing()" (click)="publishResults()">{{ 'Publish results' | t }}</button>
        </div>
      }
      @if (publishedUrl(); as url) { <p class="at-card" role="status">{{ publishNote() }} <a [href]="url" target="_blank" rel="noopener noreferrer">{{ 'Open' | t }}</a></p> }
      @else if (publishNote()) { <p class="at-card" role="status">{{ publishNote() }}</p> }
      @if (issues().length > 0) {
        <p>{{ 'Defects' | t }}:
          @for (i of issues(); track i.issueKey) { <a class="at-badge mono" [href]="i.issueUrl" target="_blank" rel="noopener noreferrer" [title]="i.title">{{ i.issueKey }}</a> }
        </p>
      }
      @if (d.shards?.length) {
        <section class="at-card at-stack">
          <h2>{{ 'Shards' | t }} <span class="at-muted">{{ 'the run split across agents' | t }}</span></h2>
          <table class="at-table">
            <thead><tr><th>{{ 'Shard' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Agent' | t }}</th><th>{{ 'Results' | t }}</th><th>{{ 'Finished' | t }}</th></tr></thead>
            <tbody>
              @for (s of d.shards; track s.id) {
                <tr>
                  <td class="mono">{{ s.index }}/{{ s.total }}</td>
                  <td><at-status [status]="s.status" /></td>
                  <td>{{ s.agent ?? '—' }}</td>
                  <td>{{ s.counts ? (i18n.number(s.counts.passed ?? 0) + ' / ' + i18n.number(s.counts.total ?? 0)) : '—' }}</td>
                  <td>{{ i18n.date(s.finishedAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
      @if (d.execution.parentId) {
        <p class="at-muted">{{ 'Shard {i} of {n} of' | t: { i: d.execution.shardIndex ?? 0, n: d.execution.shards ?? 0 } }} <a [routerLink]="['/runs', d.execution.parentId]">{{ 'the whole run' | t }}</a></p>
      }
      <at-run-findings [executionId]="d.execution.id" [projectId]="d.execution.projectId" [canEdit]="session.can('project.edit')" [finished]="!active()" />
      @if (d.execution.status === 'queued') { <p class="at-alert info">{{ 'Waiting for an agent…' | t }}</p> }

      <table class="at-table">
        <thead><tr><th>{{ 'Status' | t }}</th><th>{{ 'Name' | t }}</th><th>{{ 'Category' | t }}</th><th>{{ 'Duration' | t }}</th></tr></thead>
        <tbody>
          @for (r of d.results; track r.id) {
            <tr>
              <td><at-status [status]="r.flaky ? 'flaky' : r.status" />@if (r.healing.length) { <at-status status="healed" /> }</td>
              <td>
                <b>{{ r.title }}</b>
                <div class="at-muted">{{ r.module }} @if (r.caseKey) { · <span class="mono">{{ r.caseKey }}{{ r.rowKey ? ' · ' + r.rowKey : '' }}</span> }</div>
                @for (h of r.healing; track $index) {
                  <div class="heal">
                    <b class="mono">{{ h.target }}</b> · {{ h.kind }} @if (h.purpose === 'check') { · <b>{{ 'during a check' | t }}</b> }
                    <div><span class="at-muted">{{ 'Original failure' | t }}:</span> {{ h.original }}</div>
                    <div><span class="at-muted">{{ 'Healed by' | t }}:</span> {{ h.healedBy }} {{ h.fix }}</div>
                  </div>
                }
                @if (r.error) { <pre class="at-pre">{{ r.error }}</pre> }
                @if (r.evidence?.length) {
                  <div class="evidence">
                    @for (f of r.evidence; track f.id) {
                      <button type="button" class="at-btn" (click)="open(f)" [title]="f.name">
                        {{ f.kind | t }} <span class="at-muted">{{ size(f.sizeBytes) }}</span>
                      </button>
                    }
                  </div>
                }
              </td>
              <td>{{ r.category ? (r.category | t) : '—' }}</td>
              <td>{{ r.durationMs !== null ? i18n.number(r.durationMs / 1000) + ' s' : '—' }}</td>
            </tr>
          } @empty { <tr><td colspan="4"><at-empty /></td></tr> }
        </tbody>
      </table>
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .evidence { display: flex; flex-wrap: wrap; gap: var(--at-space-2); margin-block-start: var(--at-space-2); }
    .viewer { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: rgb(0 0 0 / 0.7); padding: var(--at-space-6); }
    .viewer figure { margin: 0; max-inline-size: min(1200px, 100%); background: var(--at-color-surface); border-radius: var(--at-radius-sm); padding: var(--at-space-3); }
    .viewer img, .viewer video { display: block; max-inline-size: 100%; max-block-size: 75vh; margin-inline: auto; }
    .viewer figcaption { margin-block-start: var(--at-space-3); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--at-space-4); margin-block: var(--at-space-4); }
    .big { font-size: 26px; font-weight: 700; }
    .ok { color: var(--at-color-ok); } .bad { color: var(--at-color-bad); }
    .heal { margin-block-start: var(--at-space-2); padding: var(--at-space-2) var(--at-space-3); border-radius: var(--at-radius-sm); background: var(--at-color-warn-bg); font-size: 13px; }
  `],
})
export class RunPage {
  readonly executionId = input.required<string>();
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly detail = signal<ExecutionDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly active = computed(() => ACTIVE.includes(this.detail()?.execution.status ?? ''));
  /** explore / export jobs show what they produced instead of test results */
  protected readonly jobKind = computed(() => {
    const k = this.detail()?.execution.selection?.['kind'];
    return k === 'explore' || k === 'export' ? (k as 'explore' | 'export') : null;
  });
  private timer?: ReturnType<typeof setTimeout>;
  protected readonly trackers = signal<Integration[]>([]);
  protected readonly publishers = signal<Integration[]>([]);
  protected readonly publishedUrl = signal<string | null>(null);
  protected publisher = '';
  protected readonly issues = signal<FiledIssue[]>([]);
  protected readonly publishing = signal(false);
  protected readonly publishNote = signal<string | null>(null);
  protected readonly session = inject(Session);
  protected tracker = '';
  protected readonly preview = signal<{ url: SafeUrl; raw: string; name: string; kind: string } | null>(null);
  private readonly sanitizer = inject(DomSanitizer);

  constructor() {
    effect(() => { void this.load(this.executionId()); });
    inject(DestroyRef).onDestroy(() => { clearTimeout(this.timer); this.closePreview(); });
  }

  protected count(status: string) { return this.detail()?.results.filter((r) => r.status === status).length ?? 0; }
  protected healedCount() { return this.detail()?.results.filter((r) => r.healing.length > 0).length ?? 0; }

  private async load(id: string) {
    clearTimeout(this.timer);
    try {
      this.detail.set(await firstValueFrom(this.api.execution(id)));
      this.error.set(null);
    } catch (e) {
      this.error.set(problemText(e));
    }
    // follow a run that is still going
    if (this.active()) { this.timer = setTimeout(() => void this.load(id), 4000); return; }
    await this.loadDefects(id);
  }

  protected size(bytes: number) {
    return bytes >= 1024 * 1024 ? `${this.i18n.number(Math.round(bytes / 1024 / 102.4) / 10)} MB` : `${this.i18n.number(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }

  /** screenshots and videos open in a viewer; traces and other files are saved */
  protected async open(f: EvidenceFile) {
    try {
      const blob = await firstValueFrom(this.api.evidence(f.id));
      const raw = URL.createObjectURL(blob);
      if (f.kind === 'screenshot' || f.kind === 'video') {
        this.closePreview();
        this.preview.set({ url: this.sanitizer.bypassSecurityTrustUrl(raw), raw, name: f.name, kind: f.kind });
        return;
      }
      const a = document.createElement('a');
      a.href = raw;
      a.download = f.kind === 'trace' && !f.name.endsWith('.zip') ? `${f.name}.zip` : f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(raw), 10_000);
    } catch (e) {
      this.error.set(problemText(e));
    }
  }

  protected closePreview() {
    const p = this.preview();
    if (p) URL.revokeObjectURL(p.raw);
    this.preview.set(null);
  }

  private async loadDefects(id: string) {
    try {
      const [all, issues] = await Promise.all([firstValueFrom(this.api.integrations()), firstValueFrom(this.api.issues(id))]);
      // defect trackers file failures; test-management tools receive the whole run
      this.trackers.set(all.filter((i) => i.enabled && i.kind !== 'testrail'));
      this.publishers.set(all.filter((i) => i.enabled && i.kind === 'testrail'));
      if (!this.publisher) this.publisher = this.publishers()[0]?.id ?? '';
      this.issues.set(issues);
      if (!this.tracker) this.tracker = this.trackers()[0]?.id ?? '';
    } catch { /* no integrations visible: the panel stays hidden */ }
  }

  protected async publish() {
    if (!this.tracker) return;
    this.publishing.set(true);
    try {
      const r = await firstValueFrom(this.api.publishIssues(this.executionId(), this.tracker));
      const parts = [this.i18n.t('{n} defects filed', { n: r.created.length })];
      if (r.alreadyFiled) parts.push(this.i18n.t('{n} already filed', { n: r.alreadyFiled }));
      if (r.failed.length) parts.push(this.i18n.t('{n} could not be filed: {error}', { n: r.failed.length, error: r.failed[0].error }));
      this.publishNote.set(parts.join(' · '));
      this.issues.set(await firstValueFrom(this.api.issues(this.executionId())));
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.publishing.set(false);
    }
  }

  protected async publishResults() {
    if (!this.publisher) return;
    this.publishing.set(true);
    this.publishedUrl.set(null);
    try {
      const r = await firstValueFrom(this.api.publishResults(this.executionId(), this.publisher));
      const parts = [this.i18n.t('{n} test cases published to {name}', { n: r.published, name: r.integration })];
      if (r.notLinked) parts.push(this.i18n.t('{n} results not linked (tag cases with @C123)', { n: r.notLinked }));
      this.publishNote.set(parts.join(' · '));
      this.publishedUrl.set(/^https?:\/\//.test(r.url) ? r.url : null);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.publishing.set(false);
    }
  }

  protected async cancel() {
    try {
      await firstValueFrom(this.api.cancelExecution(this.executionId()));
      await this.load(this.executionId());
    } catch (e) {
      this.error.set(problemText(e));
    }
  }
}
