import { Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Artifact, FoundMessage, Findings } from '../core/models';
import { ErrorState } from '../core/states';

/**
 * Downloads (Smart Report, CSV) and post-run findings of a run (backlog §11): pages the tests reached that are not in
 * the object repository, and messages that popped up — each one a click away from a new page, expected message or case.
 */
@Component({
  selector: 'at-run-findings',
  standalone: true,
  imports: [TranslatePipe, ErrorState],
  template: `
    <at-error [message]="error()" />
    @if (note()) { <p class="at-card" role="status">{{ note() }}</p> }
    <div class="at-row wrap downloads">
      @for (a of artifacts(); track a.id) {
        <button type="button" class="at-btn" (click)="download(a)">⤓ {{ (a.kind === 'report' ? 'Smart Report' : a.name) | t }}</button>
      }
      <button type="button" class="at-btn" (click)="csv()">⤓ {{ 'Results (CSV)' | t }}</button>
    </div>

    @if (findings(); as f) {
      @if (f.newPages.length || f.messages.length) {
        <section class="at-card at-stack">
          <h2>{{ 'Findings' | t }} <span class="at-muted">{{ 'what the tests met on the way' | t }}</span></h2>
          @if (f.newPages.length) {
            <h3>{{ 'Pages not in the object repository' | t }}</h3>
            <table class="at-table">
              <thead><tr><th>{{ 'Address' | t }}</th><th>{{ 'Seen by' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (p of f.newPages; track p.url) {
                  <tr>
                    <td class="mono" dir="ltr">{{ p.url }}</td>
                    <td>{{ i18n.number(p.tests) }} <span class="at-muted">{{ p.seenBy.join(', ') }}</span></td>
                    <td>@if (canEdit()) { <button type="button" class="at-btn" (click)="newPage(p.url)">{{ 'Add as a page' | t }}</button> }</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          @if (f.messages.length) {
            <h3>{{ 'Messages' | t }}</h3>
            <table class="at-table">
              <thead><tr><th>{{ 'Text' | t }}</th><th>{{ 'Kind' | t }}</th><th>{{ 'Page' | t }}</th><th>{{ 'Seen by' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (m of f.messages; track $index) {
                  <tr>
                    <td [attr.dir]="rtl(m.text) ? 'rtl' : 'ltr'">{{ m.text }}@if (m.selector) { <div class="at-muted mono" dir="ltr">{{ m.selector }}</div> }</td>
                    <td>{{ m.kind | t }}@if (m.tone) { · {{ m.tone | t }} }</td>
                    <td class="mono">{{ m.page ?? '—' }}</td>
                    <td>{{ i18n.number(m.tests) }} <span class="at-muted">{{ m.seenBy.join(', ') }}</span></td>
                    <td>
                      @if (m.known) { <span class="at-badge ok">{{ 'expected' | t }}</span> }
                      @else if (canEdit()) { <button type="button" class="at-btn" (click)="addMessage(m)">{{ 'Add as expected message' | t }}</button> }
                      @if (m.page && canEdit()) { <button type="button" class="at-btn" (click)="newCase(m.page)">{{ 'New test case here' | t }}</button> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }
    }
  `,
  styles: [`.downloads { margin-block: var(--at-space-3); flex-wrap: wrap; } section.at-card { margin-block: var(--at-space-4); }`],
})
export class RunFindingsComponent {
  readonly executionId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly canEdit = input(false);
  /** reload when the run finishes */
  readonly finished = input(false);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly i18n = inject(I18n);
  protected readonly findings = signal<Findings | null>(null);
  protected readonly artifacts = signal<Artifact[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);

  constructor() {
    effect(() => { if (this.finished()) void this.load(this.executionId()); });
  }

  private async load(id: string) {
    try {
      const [findings, artifacts] = await Promise.all([firstValueFrom(this.api.findings(id)), firstValueFrom(this.api.artifacts(id))]);
      this.findings.set(findings);
      this.artifacts.set(artifacts);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected rtl(text: string) { return /[؀-ۿ]/.test(text); }

  private save(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async download(a: Artifact) {
    try { this.save(await firstValueFrom(this.api.artifact(a.id)), a.name); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async csv() {
    try { this.save(await firstValueFrom(this.api.resultsCsv(this.executionId())), `run-${this.executionId().slice(0, 8)}.csv`); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected newPage(url: string) {
    let path = url;
    try { path = new URL(url).pathname; } catch { /* keep as is */ }
    void this.router.navigate(['/projects', this.projectId(), 'new-page'], { queryParams: { url: path } });
  }

  protected newCase(page: string) { void this.router.navigate(['/projects', this.projectId(), 'new-case'], { queryParams: { page } }); }

  /** suggests a key from the text (first words, camelCase); the language follows the script */
  async addMessage(m: FoundMessage) {
    const words = m.text.normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => /^[A-Za-z0-9]+$/.test(w)).slice(0, 4);
    const suggested = words.length ? words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') : 'message';
    const key = prompt(this.i18n.t('Key for this message (used as {{msg.key}}):'), suggested)?.trim();
    if (!key) return;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(key)) { this.error.set(this.i18n.t('Keys use letters, digits and _, starting with a letter.')); return; }
    const locale = this.rtl(m.text) ? 'ar' : 'en';
    try {
      const all = await firstValueFrom(this.api.messages(this.projectId()));
      const set = { ...(all[locale] ?? {}) };
      if (set[key] !== undefined && !confirm(this.i18n.t('Replace the message "{key}"?', { key }))) return;
      set[key] = m.text;
      await firstValueFrom(this.api.putMessages(this.projectId(), { ...all, [locale]: set }));
      this.note.set(this.i18n.t('Added as {{msg.{key}}}.', { key }));
      await this.load(this.executionId());
    } catch (e) { this.error.set(problemText(e)); }
  }
}
