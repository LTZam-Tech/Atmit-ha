import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import { Session } from '../core/session';
import type { Project, Workspace } from '../core/models';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

interface WorkspaceView { ws: Workspace; projects: Project[] }

/** Workspaces with their projects; create a project or import a 0.1.0 project snapshot. */
@Component({
  selector: 'at-workspaces',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorState, LoadingState, EmptyState],
  template: `
    <div class="at-row"><h1 class="at-grow">{{ 'Projects' | t }}</h1></div>
    <at-error [message]="error()" />
    @if (loading()) { <at-loading /> }
    @for (v of views(); track v.ws.id) {
      <section class="at-card at-stack ws">
        <div class="at-row">
          @if (renaming() === v.ws.key) {
            <form class="at-row at-grow" (ngSubmit)="saveName(v.ws.key)">
              <input class="at-input" name="rename-{{ v.ws.key }}" [(ngModel)]="renameTo" [attr.aria-label]="'Workspace name' | t">
              <button type="submit" class="at-btn primary" [disabled]="!renameTo.trim()">{{ 'Save' | t }}</button>
              <button type="button" class="at-btn" (click)="renaming.set(null)">{{ 'Cancel' | t }}</button>
            </form>
          } @else {
            <h2 class="at-grow">{{ 'Workspace' | t }}: {{ v.ws.name }} <span class="at-muted mono">{{ v.ws.key }}</span></h2>
          }
          @if (session.can('workspace.manage') && renaming() !== v.ws.key) {
            <button type="button" class="at-btn" (click)="startRename(v.ws)">{{ 'Rename' | t }}</button>
            <button type="button" class="at-btn danger" (click)="archive(v)" [title]="v.projects.length ? ('Archive or move its projects first.' | t) : ''">{{ 'Archive' | t }}</button>
          }
          <label class="at-btn">
            {{ 'Import 0.1.0 project' | t }}
            <input type="file" accept="application/json,.json" hidden (change)="importFile(v.ws.key, $event)">
          </label>
        </div>
        @if (v.projects.length === 0) { <at-empty /> }
        @else {
          <table class="at-table">
            <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Key' | t }}</th><th>{{ 'Self-healing' | t }}</th><th>{{ 'Updated' | t }}</th></tr></thead>
            <tbody>
              @for (p of v.projects; track p.id) {
                <tr>
                  <td><a [routerLink]="['/projects', p.id]">{{ p.name }}</a></td>
                  <td class="mono">{{ p.key }}</td>
                  <td>{{ p.healingPolicy | t }}</td>
                  <td>{{ i18n.date(p.updatedAt) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
        <form class="at-row" (ngSubmit)="create(v.ws.key)">
          <input class="at-input" name="key-{{ v.ws.key }}" [(ngModel)]="newKey" [placeholder]="'Key' | t" dir="ltr" pattern="[a-z][a-z0-9-]*">
          <input class="at-input" name="name-{{ v.ws.key }}" [(ngModel)]="newName" [placeholder]="'Name' | t">
          <button type="submit" class="at-btn primary" [disabled]="!newKey || !newName">{{ 'New project' | t }}</button>
        </form>
      </section>
    } @empty {
      @if (!loading()) { <at-empty /> }
    }
    @if (notice()) { <p class="at-alert info" role="status">{{ notice() }}</p> }
  `,
  styles: [`.ws { margin-block-end: var(--at-space-6); }`],
})
export class WorkspacesPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly renaming = signal<string | null>(null);
  protected renameTo = '';
  protected readonly views = signal<WorkspaceView[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected newKey = '';
  protected newName = '';

  async ngOnInit() { await this.load(); }

  async load() {
    this.loading.set(true);
    try {
      const ws = await firstValueFrom(this.api.workspaces());
      const views = await Promise.all(ws.map(async (w) => ({ ws: w, projects: await firstValueFrom(this.api.projects(w.key)) })));
      this.views.set(views);
      this.error.set(null);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.loading.set(false);
    }
  }

  async create(workspaceKey: string) {
    try {
      await firstValueFrom(this.api.createProject(workspaceKey, { key: this.newKey.trim(), name: this.newName.trim() }));
      this.newKey = this.newName = '';
      await this.load();
    } catch (e) {
      this.error.set(problemText(e));
    }
  }

  async importFile(workspaceKey: string, event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const snapshot: unknown = JSON.parse(await file.text());
      const r = await firstValueFrom(this.api.importProject(workspaceKey, snapshot));
      this.notice.set(this.i18n.t('Imported: {pages} pages, {cases} cases, {rows} data rows.', { pages: r.pages, cases: r.cases, rows: r.dataRows }));
      this.error.set(null);
      await this.load();
    } catch (e) {
      this.error.set(problemText(e));
    }
  }

  startRename(ws: Workspace) { this.renameTo = ws.name; this.renaming.set(ws.key); }

  async saveName(key: string) {
    try {
      await firstValueFrom(this.api.renameWorkspace(key, this.renameTo.trim()));
      this.renaming.set(null);
      this.error.set(null);
      await this.load();
    } catch (e) {
      this.error.set(problemText(e));
    }
  }

  async archive(v: WorkspaceView) {
    if (v.projects.length) { this.error.set(this.i18n.t('The workspace still has {n} active project(s). Archive or move them first.', { n: v.projects.length })); return; }
    if (!confirm(this.i18n.t('Archive the workspace {name}?', { name: v.ws.name }))) return;
    try {
      await firstValueFrom(this.api.archiveWorkspace(v.ws.key));
      this.error.set(null);
      await this.load();
    } catch (e) {
      this.error.set(problemText(e));
    }
  }
}
