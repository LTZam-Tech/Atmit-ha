import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import { Session } from '../core/session';
import type { PlatformOrganization } from '../core/models';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

/** Platform administration (Platform:Admins only): create, rename, archive and restore organisations. */
@Component({
  selector: 'at-platform',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorState, LoadingState, EmptyState],
  template: `
    <div class="at-row"><h1 class="at-grow">{{ 'Organisations' | t }}</h1>
      @if (!session.organization()) { <a class="at-btn" routerLink="/organisations">{{ 'Back' | t }}</a> }</div>
    @if (!session.me()?.platformAdmin) {
      <p class="at-alert" role="alert">{{ 'Only a platform administrator can manage organisations.' | t }}</p>
    } @else {
      <at-error [message]="error()" />
      @if (notice()) { <p class="at-alert info" role="status">{{ notice() }}</p> }

      <form class="at-card at-stack" (ngSubmit)="create()">
        <h2>{{ 'New organisation' | t }}</h2>
        <div class="at-row wrap">
          <label class="at-field">{{ 'Key' | t }}
            <input class="at-input" name="key" [(ngModel)]="key" dir="ltr" pattern="[a-z][a-z0-9-]*" required>
          </label>
          <label class="at-field">{{ 'Name' | t }}
            <input class="at-input" name="name" [(ngModel)]="name" required>
          </label>
          <label class="at-field">{{ 'First administrator email' | t }}
            <input class="at-input" name="adminEmail" type="email" [(ngModel)]="adminEmail" dir="ltr" required>
          </label>
          <label class="at-field">{{ 'Display name' | t }}
            <input class="at-input" name="adminName" [(ngModel)]="adminName">
          </label>
        </div>
        <p class="at-muted">{{ 'The first administrator is invited by email and is linked when they first sign in.' | t }}</p>
        <div class="at-row"><button type="submit" class="at-btn primary" [disabled]="busy() || !key || !name || !adminEmail">{{ 'Create organisation' | t }}</button></div>
      </form>

      @if (loading()) { <at-loading /> }
      @else {
        <table class="at-table">
          <thead><tr>
            <th>{{ 'Name' | t }}</th><th>{{ 'Key' | t }}</th><th>{{ 'Workspaces' | t }}</th><th>{{ 'Projects' | t }}</th>
            <th>{{ 'Members' | t }}</th><th>{{ 'Created' | t }}</th><th>{{ 'Status' | t }}</th><th></th>
          </tr></thead>
          <tbody>
            @for (o of orgs(); track o.id) {
              <tr [class.at-muted]="o.archivedAt">
                <td>
                  @if (editing() === o.key) {
                    <input class="at-input" [attr.aria-label]="'Name' | t" [(ngModel)]="rename" name="rename-{{ o.key }}">
                  } @else { {{ o.name }} }
                </td>
                <td class="mono">{{ o.key }}</td>
                <td>{{ o.workspaces }}</td><td>{{ o.projects }}</td><td>{{ o.members }}</td>
                <td>{{ i18n.date(o.createdAt) }}</td>
                <td>{{ (o.archivedAt ? 'Archived' : 'Active') | t }}</td>
                <td class="at-row">
                  @if (editing() === o.key) {
                    <button type="button" class="at-btn primary" [disabled]="busy() || !rename.trim()" (click)="saveName(o)">{{ 'Save' | t }}</button>
                    <button type="button" class="at-btn" (click)="editing.set(null)">{{ 'Cancel' | t }}</button>
                  } @else {
                    <button type="button" class="at-btn" (click)="startRename(o)">{{ 'Rename' | t }}</button>
                    @if (o.archivedAt) {
                      <button type="button" class="at-btn" [disabled]="busy()" (click)="setArchived(o, false)">{{ 'Restore' | t }}</button>
                    } @else {
                      <button type="button" class="at-btn danger" [disabled]="busy()" (click)="setArchived(o, true)">{{ 'Archive' | t }}</button>
                    }
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="8"><at-empty /></td></tr>
            }
          </tbody>
        </table>
      }
    }
  `,
  styles: [`.wrap { flex-wrap: wrap; } form { margin-block-end: var(--at-space-6); }
    /* shown without the app shell when the person has no organisation yet (a new installation) */
    :host { display: block; } :host(.bare) { padding: var(--at-space-6); }`],
  host: { '[class.bare]': '!session.organization()' },
})
export class PlatformPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly orgs = signal<PlatformOrganization[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected key = '';
  protected name = '';
  protected adminEmail = '';
  protected adminName = '';
  protected rename = '';

  async ngOnInit() {
    if (this.session.me()?.platformAdmin) await this.load();
    else this.loading.set(false);
  }

  async load() {
    this.loading.set(true);
    try { this.orgs.set(await firstValueFrom(this.api.platformOrganizations())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
    finally { this.loading.set(false); }
  }

  async create() {
    await this.run(async () => {
      const o = await firstValueFrom(this.api.createOrganization({
        key: this.key.trim(), name: this.name.trim(), adminEmail: this.adminEmail.trim(), ...(this.adminName.trim() ? { adminName: this.adminName.trim() } : {}),
      }));
      this.notice.set(this.i18n.t('Organisation {name} created; {email} is its administrator.', { name: o.name, email: this.adminEmail.trim() }));
      this.key = this.name = this.adminEmail = this.adminName = '';
    });
  }

  startRename(o: PlatformOrganization) { this.rename = o.name; this.editing.set(o.key); }

  async saveName(o: PlatformOrganization) {
    await this.run(async () => {
      await firstValueFrom(this.api.updateOrganization(o.key, { name: this.rename.trim() }));
      this.editing.set(null);
      this.notice.set(null);
    });
  }

  async setArchived(o: PlatformOrganization, archived: boolean) {
    if (archived && !confirm(this.i18n.t('Archive {name}? Nobody can sign in to it until it is restored.', { name: o.name }))) return;
    await this.run(async () => {
      await firstValueFrom(this.api.updateOrganization(o.key, { archived }));
      this.notice.set(null);
    });
  }

  private async run(work: () => Promise<void>) {
    this.busy.set(true);
    try { await work(); this.error.set(null); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
    finally { this.busy.set(false); }
  }
}
