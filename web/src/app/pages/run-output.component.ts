import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import { Session } from '../core/session';
import type { Artifact } from '../core/models';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

interface ExploredPage { key: string; url: string; title: string; elements: number; content: Record<string, unknown> }
interface ExploreFile { pages: ExploredPage[]; errors: { url: string; error: string }[]; signedInAs: string | null }
interface PageRow extends ExploredPage { sentTo?: string; busy?: boolean }

/**
 * What an "explore" or "export" job produced (backlog §3/§6): collected draft pages, each sent to review as a new
 * page (change set item assetType page, baseVersion null); or the exported Playwright project as a ZIP.
 */
@Component({
  selector: 'at-run-output',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorState, LoadingState, EmptyState],
  template: `
    <at-error [message]="error()" />
    @if (kind() === 'export') {
      <section class="at-card at-stack">
        <h2>{{ 'Playwright code' | t }}</h2>
        @if (exportFile(); as a) {
          <p class="at-muted">{{ 'A standalone Playwright and TypeScript project made from this project: page objects, tests, data and login setup.' | t }}</p>
          <div class="at-row"><button type="button" class="at-btn primary" (click)="downloadZip(a)">⤓ {{ 'Download the project (ZIP)' | t }}</button></div>
        } @else if (!loading()) { <p class="at-muted">{{ 'The export is not ready.' | t }}</p> }
      </section>
    }
    @if (kind() === 'explore') {
      <section class="at-card at-stack">
        <h2>{{ 'Collected pages' | t }}
          @if (signedInAs()) { <span class="at-muted">{{ 'signed in as {user}' | t: { user: signedInAs() ?? '' } }}</span> }</h2>
        @if (loading()) { <at-loading /> }
        @for (e of failures(); track e.url) { <p class="at-alert"><span class="mono" dir="ltr">{{ e.url }}</span>: {{ e.error }}</p> }
        @if (pages().length) {
          <table class="at-table">
            <thead><tr><th>{{ 'Page key' | t }}</th><th>{{ 'Address' | t }}</th><th>{{ 'Title' | t }}</th><th>{{ 'Elements' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (p of pages(); track p.url) {
                <tr>
                  <td><input class="at-input mono" [(ngModel)]="p.key" dir="ltr" [attr.aria-label]="'Page key' | t" [disabled]="!!p.sentTo"></td>
                  <td class="mono" dir="ltr">{{ p.url }}</td>
                  <td>{{ p.title }}</td>
                  <td>{{ i18n.number(p.elements) }}</td>
                  <td>
                    @if (p.sentTo) { <a class="at-btn" [routerLink]="['/change-sets', p.sentTo]">{{ 'Open the review' | t }}</a> }
                    @else if (session.can('project.edit')) {
                      <button type="button" class="at-btn primary" [disabled]="p.busy || !validKey(p.key)" (click)="send(p)">{{ 'Send for review' | t }}</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loading() && !failures().length) { <at-empty text="No pages were collected." /> }
      </section>
    }
  `,
})
export class RunOutputComponent {
  readonly executionId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly kind = input.required<'explore' | 'export'>();
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly exportFile = signal<Artifact | null>(null);
  protected readonly pages = signal<PageRow[]>([]);
  protected readonly failures = signal<ExploreFile['errors']>([]);
  protected readonly signedInAs = signal<string | null>(null);

  constructor() {
    effect(() => { void this.load(this.executionId(), this.kind()); });
  }

  private async load(id: string, kind: 'explore' | 'export') {
    this.loading.set(true);
    try {
      const files = await firstValueFrom(this.api.artifacts(id));
      if (kind === 'export') this.exportFile.set(files.find((a) => a.name === 'playwright-project.json') ?? null);
      else {
        const f = files.find((a) => a.name === 'explore.json');
        if (f) {
          const data = JSON.parse(await (await firstValueFrom(this.api.artifact(f.id))).text()) as ExploreFile;
          this.pages.set((data.pages ?? []).map((p) => ({ ...p })));
          this.failures.set(data.errors ?? []);
          this.signedInAs.set(data.signedInAs ?? null);
        }
      }
      this.error.set(null);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected validKey(k: string) { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(k); }

  /** a new page for review: the draft as collected, under the key chosen here */
  protected async send(p: PageRow) {
    p.busy = true;
    try {
      const cs = await firstValueFrom(this.api.submitChangeSet(this.projectId(), {
        title: this.i18n.t('New page {key} (collected by Explore)', { key: p.key }),
        items: [{ assetType: 'page', key: p.key, baseVersion: null, content: { ...p.content, page: p.key } }],
      }));
      p.sentTo = cs.id;
      this.error.set(null);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      p.busy = false;
      this.pages.update((list) => [...list]);
    }
  }

  protected async downloadZip(a: Artifact) {
    try {
      const blob = await firstValueFrom(this.api.artifactZip(a.id));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'playwright-project.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      this.error.set(problemText(e));
    }
  }
}
